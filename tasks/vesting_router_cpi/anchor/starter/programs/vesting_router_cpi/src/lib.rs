use std::convert::TryFrom;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use guarded_vault::{self, program::GuardedVault, VaultState};

declare_id!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

const STREAM_SEED: &[u8] = b"stream";
const ROUTER_AUTHORITY_SEED: &[u8] = b"router_authority";

#[program]
pub mod vesting_router_cpi {
    use super::*;

    pub fn initialize_stream(
        ctx: Context<InitializeStream>,
        seed: u64,
        total_amount: u64,
        cliff_round: u64,
        total_rounds: u64,
    ) -> Result<()> {
        require!(total_amount > 0, StreamError::AmountMustBePositive);
        require!(total_rounds > 0, StreamError::InvalidRoundConfiguration);
        require!(cliff_round <= total_rounds, StreamError::InvalidRoundConfiguration);

        guarded_vault::cpi::initialize_vault(
            CpiContext::new(
                ctx.accounts.guarded_vault_program.to_account_info(),
                guarded_vault::cpi::accounts::InitializeVault {
                    admin: ctx.accounts.admin.to_account_info(),
                    controller: ctx.accounts.router_authority.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    vault: ctx.accounts.vault.to_account_info(),
                    vault_authority: ctx.accounts.vault_authority.to_account_info(),
                    vault_token: ctx.accounts.vault_token.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            ),
            seed,
            ctx.accounts.router_authority.key(),
        )?;

        let stream = &mut ctx.accounts.stream;
        stream.seed = seed;
        stream.admin = ctx.accounts.admin.key();
        stream.beneficiary = ctx.accounts.beneficiary.key();
        stream.mint = ctx.accounts.mint.key();
        stream.total_amount = total_amount;
        stream.claimed_amount = 0;
        stream.cliff_round = cliff_round;
        stream.total_rounds = total_rounds;
        stream.current_round = 0;
        stream.router_authority_bump = ctx.bumps.router_authority;
        stream.vault = ctx.accounts.vault.key();
        stream.funded = false;
        Ok(())
    }

    pub fn fund(ctx: Context<Fund>) -> Result<()> {
        require!(!ctx.accounts.stream.funded, StreamError::AlreadyFunded);

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.admin_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault_token.to_account_info(),
            authority: ctx.accounts.admin.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_accounts),
            ctx.accounts.stream.total_amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.stream.funded = true;
        Ok(())
    }

    pub fn advance_round(ctx: Context<AdvanceRound>, new_round: u64) -> Result<()> {
        require!(
            new_round > ctx.accounts.stream.current_round,
            StreamError::InvalidRoundAdvance
        );
        require!(
            new_round <= ctx.accounts.stream.total_rounds,
            StreamError::InvalidRoundAdvance
        );

        ctx.accounts.stream.current_round = new_round;
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        require!(ctx.accounts.stream.funded, StreamError::NotFunded);

        let vested_amount = vested_amount(&ctx.accounts.stream)?;
        let claim_amount = vested_amount;
        require!(claim_amount > 0, StreamError::NothingToClaim);

        let stream_key = ctx.accounts.stream.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            ROUTER_AUTHORITY_SEED,
            stream_key.as_ref(),
            &[ctx.accounts.stream.router_authority_bump],
        ]];

        guarded_vault::cpi::release(
            CpiContext::new_with_signer(
                ctx.accounts.guarded_vault_program.to_account_info(),
                guarded_vault::cpi::accounts::Release {
                    controller: ctx.accounts.router_authority.to_account_info(),
                    vault: ctx.accounts.vault.to_account_info(),
                    vault_authority: ctx.accounts.vault_authority.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    vault_token: ctx.accounts.vault_token.to_account_info(),
                    recipient_token: ctx.accounts.beneficiary_token.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                signer_seeds,
            ),
            claim_amount,
        )?;

        ctx.accounts.stream.claimed_amount = ctx
            .accounts
            .stream
            .claimed_amount
            .checked_add(claim_amount)
            .ok_or(StreamError::MathOverflow)?;
        Ok(())
    }
}

fn vested_amount(stream: &Stream) -> Result<u64> {
    if stream.current_round < stream.cliff_round {
        return Ok(0);
    }

    let vested_rounds = stream.current_round.min(stream.total_rounds);
    let vested_amount = (stream.total_amount as u128)
        .checked_mul(vested_rounds as u128)
        .ok_or(StreamError::MathOverflow)?
        .checked_div(stream.total_rounds as u128)
        .ok_or(StreamError::MathOverflow)?;

    u64::try_from(vested_amount).map_err(|_| error!(StreamError::MathOverflow))
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct InitializeStream<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub beneficiary: SystemAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + Stream::INIT_SPACE,
        seeds = [STREAM_SEED, admin.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub stream: Account<'info, Stream>,
    #[account(
        seeds = [ROUTER_AUTHORITY_SEED, stream.key().as_ref()],
        bump
    )]
    /// CHECK: PDA used as the helper-vault controller.
    pub router_authority: UncheckedAccount<'info>,
    pub guarded_vault_program: Program<'info, GuardedVault>,
    #[account(mut)]
    /// CHECK: created by the helper CPI.
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: PDA used by the helper CPI.
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: created by the helper CPI.
    pub vault_token: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [STREAM_SEED, stream.admin.as_ref(), &stream.seed.to_le_bytes()],
        bump,
        has_one = mint @ StreamError::InvalidMint
    )]
    pub stream: Account<'info, Stream>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = admin
    )]
    pub admin_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdvanceRound<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [STREAM_SEED, stream.admin.as_ref(), &stream.seed.to_le_bytes()],
        bump
    )]
    pub stream: Account<'info, Stream>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub beneficiary: Signer<'info>,
    #[account(
        mut,
        seeds = [STREAM_SEED, stream.admin.as_ref(), &stream.seed.to_le_bytes()],
        bump,
        has_one = mint @ StreamError::InvalidMint
    )]
    pub stream: Account<'info, Stream>,
    #[account(
        seeds = [ROUTER_AUTHORITY_SEED, stream.key().as_ref()],
        bump = stream.router_authority_bump
    )]
    /// CHECK: PDA signer for helper CPI.
    pub router_authority: UncheckedAccount<'info>,
    pub guarded_vault_program: Program<'info, GuardedVault>,
    #[account(mut)]
    pub vault: Account<'info, VaultState>,
    #[account(
        seeds = [b"vault_authority", vault.key().as_ref()],
        seeds::program = guarded_vault::ID,
        bump = vault.vault_authority_bump
    )]
    /// CHECK: checked by PDA derivation against the helper program.
    pub vault_authority: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = vault_authority
    )]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint
    )]
    pub beneficiary_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Stream {
    pub seed: u64,
    pub admin: Pubkey,
    pub beneficiary: Pubkey,
    pub mint: Pubkey,
    pub total_amount: u64,
    pub claimed_amount: u64,
    pub cliff_round: u64,
    pub total_rounds: u64,
    pub current_round: u64,
    pub router_authority_bump: u8,
    pub vault: Pubkey,
    pub funded: bool,
}

#[error_code]
pub enum StreamError {
    #[msg("Amount must be positive")]
    AmountMustBePositive,
    #[msg("Invalid round configuration")]
    InvalidRoundConfiguration,
    #[msg("Invalid round advance")]
    InvalidRoundAdvance,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Stream is already funded")]
    AlreadyFunded,
    #[msg("Stream is not funded")]
    NotFunded,
}
