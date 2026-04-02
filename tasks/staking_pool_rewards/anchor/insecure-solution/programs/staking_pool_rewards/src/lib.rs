use std::convert::TryFrom;

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

const POOL_SEED: &[u8] = b"pool";
const POOL_AUTHORITY_SEED: &[u8] = b"pool_authority";
const POSITION_SEED: &[u8] = b"position";
const ACCUMULATOR_SCALE: u128 = 1_000_000_000;

#[program]
pub mod staking_pool_rewards {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, seed: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.seed = seed;
        pool.admin = ctx.accounts.admin.key();
        pool.stake_mint = ctx.accounts.stake_mint.key();
        pool.reward_mint = ctx.accounts.reward_mint.key();
        pool.pool_authority_bump = ctx.bumps.pool_authority;
        pool.total_staked = 0;
        pool.acc_reward_per_share = 0;
        Ok(())
    }

    pub fn deposit_rewards(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
        require!(amount > 0, PoolError::AmountMustBePositive);

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.admin_reward_token.to_account_info(),
            mint: ctx.accounts.reward_mint.to_account_info(),
            to: ctx.accounts.reward_vault.to_account_info(),
            authority: ctx.accounts.admin.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_accounts),
            amount,
            ctx.accounts.reward_mint.decimals,
        )?;

        if ctx.accounts.pool.total_staked > 0 {
            let reward_increment = (amount as u128)
                .checked_mul(ACCUMULATOR_SCALE)
                .ok_or(PoolError::MathOverflow)?
                .checked_div(ctx.accounts.pool.total_staked as u128)
                .ok_or(PoolError::MathOverflow)?;

            ctx.accounts.pool.acc_reward_per_share = ctx
                .accounts
                .pool
                .acc_reward_per_share
                .checked_add(reward_increment)
                .ok_or(PoolError::MathOverflow)?;
        }

        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, PoolError::AmountMustBePositive);

        initialize_position_if_needed(
            &mut ctx.accounts.position,
            ctx.accounts.pool.key(),
            ctx.accounts.user.key(),
        );

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.user_stake_token.to_account_info(),
            mint: ctx.accounts.stake_mint.to_account_info(),
            to: ctx.accounts.stake_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_accounts),
            amount,
            ctx.accounts.stake_mint.decimals,
        )?;

        ctx.accounts.position.amount = ctx
            .accounts
            .position
            .amount
            .checked_add(amount)
            .ok_or(PoolError::MathOverflow)?;
        ctx.accounts.pool.total_staked = ctx
            .accounts
            .pool
            .total_staked
            .checked_add(amount)
            .ok_or(PoolError::MathOverflow)?;
        refresh_reward_debt(&mut ctx.accounts.position, &ctx.accounts.pool)?;
        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, PoolError::AmountMustBePositive);
        require!(ctx.accounts.position.amount >= amount, PoolError::InsufficientStake);

        let pool_key = ctx.accounts.pool.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            POOL_AUTHORITY_SEED,
            pool_key.as_ref(),
            &[ctx.accounts.pool.pool_authority_bump],
        ]];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.stake_vault.to_account_info(),
            mint: ctx.accounts.stake_mint.to_account_info(),
            to: ctx.accounts.user_stake_token.to_account_info(),
            authority: ctx.accounts.pool_authority.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_accounts,
                signer_seeds,
            ),
            amount,
            ctx.accounts.stake_mint.decimals,
        )?;

        ctx.accounts.position.amount = ctx
            .accounts
            .position
            .amount
            .checked_sub(amount)
            .ok_or(PoolError::MathOverflow)?;
        ctx.accounts.pool.total_staked = ctx
            .accounts
            .pool
            .total_staked
            .checked_sub(amount)
            .ok_or(PoolError::MathOverflow)?;
        refresh_reward_debt(&mut ctx.accounts.position, &ctx.accounts.pool)?;
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        settle_pending_rewards(&mut ctx.accounts.position, &ctx.accounts.pool)?;

        let claim_amount = ctx.accounts.position.pending_rewards;
        require!(claim_amount > 0, PoolError::NoRewardsAvailable);

        let pool_key = ctx.accounts.pool.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            POOL_AUTHORITY_SEED,
            pool_key.as_ref(),
            &[ctx.accounts.pool.pool_authority_bump],
        ]];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.reward_vault.to_account_info(),
            mint: ctx.accounts.reward_mint.to_account_info(),
            to: ctx.accounts.user_reward_token.to_account_info(),
            authority: ctx.accounts.pool_authority.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_accounts,
                signer_seeds,
            ),
            claim_amount,
            ctx.accounts.reward_mint.decimals,
        )?;

        ctx.accounts.position.pending_rewards = 0;
        refresh_reward_debt(&mut ctx.accounts.position, &ctx.accounts.pool)?;
        Ok(())
    }
}

fn initialize_position_if_needed(position: &mut Account<Position>, pool: Pubkey, owner: Pubkey) {
    if position.owner == Pubkey::default() {
        position.pool = pool;
        position.owner = owner;
        position.amount = 0;
        position.reward_debt = 0;
        position.pending_rewards = 0;
    }
}

fn settle_pending_rewards(position: &mut Account<Position>, pool: &Account<Pool>) -> Result<()> {
    let total_accrued = current_reward_debt(position.amount, pool.acc_reward_per_share)?;
    let newly_accrued = total_accrued
        .checked_sub(position.reward_debt)
        .ok_or(PoolError::RewardDebtInvariant)?;
    let newly_accrued_u64 =
        u64::try_from(newly_accrued).map_err(|_| error!(PoolError::MathOverflow))?;

    position.pending_rewards = position
        .pending_rewards
        .checked_add(newly_accrued_u64)
        .ok_or(PoolError::MathOverflow)?;
    Ok(())
}

fn refresh_reward_debt(position: &mut Account<Position>, pool: &Account<Pool>) -> Result<()> {
    position.reward_debt = current_reward_debt(position.amount, pool.acc_reward_per_share)?;
    Ok(())
}

fn current_reward_debt(amount: u64, acc_reward_per_share: u128) -> Result<u128> {
    (amount as u128)
        .checked_mul(acc_reward_per_share)
        .ok_or_else(|| error!(PoolError::MathOverflow))?
        .checked_div(ACCUMULATOR_SCALE)
        .ok_or_else(|| error!(PoolError::MathOverflow))
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub stake_mint: Account<'info, Mint>,
    pub reward_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, admin.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()],
        bump
    )]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = stake_mint,
        associated_token::authority = pool_authority
    )]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = reward_mint,
        associated_token::authority = pool_authority
    )]
    pub reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositRewards<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, pool.admin.as_ref(), &pool.seed.to_le_bytes()],
        bump,
        has_one = reward_mint @ PoolError::InvalidMint,
        constraint = pool.admin == admin.key() @ PoolError::UnauthorizedAdmin
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.pool_authority_bump
    )]
    pub pool_authority: UncheckedAccount<'info>,
    pub reward_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = reward_mint,
        associated_token::authority = pool_authority
    )]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = admin
    )]
    pub admin_reward_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, pool.admin.as_ref(), &pool.seed.to_le_bytes()],
        bump,
        has_one = stake_mint @ PoolError::InvalidMint
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.pool_authority_bump
    )]
    pub pool_authority: UncheckedAccount<'info>,
    pub stake_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = stake_mint,
        associated_token::authority = pool_authority
    )]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = stake_mint,
        token::authority = user
    )]
    pub user_stake_token: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, pool.admin.as_ref(), &pool.seed.to_le_bytes()],
        bump,
        has_one = stake_mint @ PoolError::InvalidMint
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.pool_authority_bump
    )]
    pub pool_authority: UncheckedAccount<'info>,
    pub stake_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = stake_mint,
        associated_token::authority = pool_authority
    )]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = stake_mint
    )]
    pub user_stake_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.pool.as_ref(), position.owner.as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, pool.admin.as_ref(), &pool.seed.to_le_bytes()],
        bump,
        has_one = reward_mint @ PoolError::InvalidMint
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.pool_authority_bump
    )]
    pub pool_authority: UncheckedAccount<'info>,
    pub reward_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = reward_mint,
        associated_token::authority = pool_authority
    )]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = reward_mint
    )]
    pub user_reward_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, position.pool.as_ref(), position.owner.as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub seed: u64,
    pub admin: Pubkey,
    pub stake_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub pool_authority_bump: u8,
    pub total_staked: u64,
    pub acc_reward_per_share: u128,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub reward_debt: u128,
    pub pending_rewards: u64,
}

#[error_code]
pub enum PoolError {
    #[msg("Amount must be positive")]
    AmountMustBePositive,
    #[msg("Insufficient stake")]
    InsufficientStake,
    #[msg("No rewards available")]
    NoRewardsAvailable,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Unauthorized admin")]
    UnauthorizedAdmin,
    #[msg("Reward debt invariant violated")]
    RewardDebtInvariant,
}
