use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZNNpJpY9JxQouXnFxxkJ7");

const VAULT_SEED: &[u8] = b"vault";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";

#[program]
pub mod guarded_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        seed: u64,
        controller: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.seed = seed;
        vault.admin = ctx.accounts.admin.key();
        vault.controller = controller;
        vault.mint = ctx.accounts.mint.key();
        vault.vault_authority_bump = ctx.bumps.vault_authority;
        Ok(())
    }

    pub fn release(ctx: Context<Release>, amount: u64) -> Result<()> {
        require!(amount > 0, GuardedVaultError::AmountMustBePositive);

        let vault_key = ctx.accounts.vault.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_AUTHORITY_SEED,
            vault_key.as_ref(),
            &[ctx.accounts.vault.vault_authority_bump],
        ]];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.vault_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.recipient_token.to_account_info(),
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
        )
    }
}

#[derive(Accounts)]
#[instruction(seed: u64, controller: Pubkey)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: may be a PDA from another program.
    pub controller: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [VAULT_SEED, controller.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, VaultState>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, vault.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    pub controller: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.controller.as_ref(), &vault.seed.to_le_bytes()],
        bump,
        has_one = controller @ GuardedVaultError::InvalidController,
        has_one = mint @ GuardedVaultError::InvalidMint
    )]
    pub vault: Account<'info, VaultState>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, vault.key().as_ref()],
        bump = vault.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint
    )]
    pub recipient_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub seed: u64,
    pub admin: Pubkey,
    pub controller: Pubkey,
    pub mint: Pubkey,
    pub vault_authority_bump: u8,
}

#[error_code]
pub enum GuardedVaultError {
    #[msg("Amount must be positive")]
    AmountMustBePositive,
    #[msg("Invalid controller")]
    InvalidController,
    #[msg("Invalid mint")]
    InvalidMint,
}
