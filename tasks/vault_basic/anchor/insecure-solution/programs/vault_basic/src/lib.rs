use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

const VAULT_SEED: &[u8] = b"vault";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
const RECEIPT_SEED: &[u8] = b"receipt";

#[program]
pub mod vault_basic {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, seed: u64) -> Result<()> {
        let vault_config = &mut ctx.accounts.vault_config;
        vault_config.seed = seed;
        vault_config.admin = ctx.accounts.admin.key();
        vault_config.mint = ctx.accounts.mint.key();
        vault_config.vault_authority_bump = ctx.bumps.vault_authority;
        vault_config.paused = false;
        vault_config.total_deposited = 0;
        vault_config.total_withdrawn = 0;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::AmountMustBePositive);

        let receipt = &mut ctx.accounts.receipt;
        if receipt.owner == Pubkey::default() {
            receipt.vault_config = ctx.accounts.vault_config.key();
            receipt.owner = ctx.accounts.user.key();
            receipt.balance = 0;
        }

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.user_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_accounts),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        receipt.balance = receipt
            .balance
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        ctx.accounts.vault_config.total_deposited = ctx
            .accounts
            .vault_config
            .total_deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::AmountMustBePositive);
        require!(
            ctx.accounts.receipt.balance >= amount,
            VaultError::InsufficientBalance
        );

        let vault_key = ctx.accounts.vault_config.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_AUTHORITY_SEED,
            vault_key.as_ref(),
            &[ctx.accounts.vault_config.vault_authority_bump],
        ]];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_destination_token.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_accounts,
                signer_seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.receipt.balance = ctx
            .accounts
            .receipt
            .balance
            .checked_sub(amount)
            .ok_or(VaultError::MathOverflow)?;
        ctx.accounts.vault_config.total_withdrawn = ctx
            .accounts
            .vault_config
            .total_withdrawn
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.vault_config.paused = paused;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [VAULT_SEED, admin.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, vault_config.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.admin.as_ref(), &vault_config.seed.to_le_bytes()],
        bump,
        has_one = mint @ VaultError::InvalidMint
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = user
    )]
    pub user_token: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Receipt::INIT_SPACE,
        seeds = [RECEIPT_SEED, vault_config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.admin.as_ref(), &vault_config.seed.to_le_bytes()],
        bump,
        has_one = mint @ VaultError::InvalidMint
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, vault_config.key().as_ref()],
        bump = vault_config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_destination_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub receipt: Account<'info, Receipt>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.admin.as_ref(), &vault_config.seed.to_le_bytes()],
        bump
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub seed: u64,
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub vault_authority_bump: u8,
    pub paused: bool,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub vault_config: Pubkey,
    pub owner: Pubkey,
    pub balance: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("Vault amounts must be positive.")]
    AmountMustBePositive,
    #[msg("The vault is paused.")]
    VaultPaused,
    #[msg("The caller is not authorized to administer the vault.")]
    UnauthorizedAdmin,
    #[msg("The provided mint does not match the vault configuration.")]
    InvalidMint,
    #[msg("The receipt does not belong to the expected vault.")]
    InvalidReceipt,
    #[msg("The receipt does not belong to the expected user.")]
    InvalidReceiptOwner,
    #[msg("The provided token account is invalid.")]
    InvalidTokenAccount,
    #[msg("The receipt balance is insufficient for this withdrawal.")]
    InsufficientBalance,
    #[msg("Arithmetic overflowed during accounting updates.")]
    MathOverflow,
}
