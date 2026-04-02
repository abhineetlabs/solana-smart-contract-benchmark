use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

const VAULT_SEED: &[u8] = b"vault";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
const RECEIPT_SEED: &[u8] = b"receipt";
const LEGACY_VERSION: u8 = 1;
const CURRENT_VERSION: u8 = 2;

#[program]
pub mod vault_receipt_migration {
    use super::*;

    pub fn initialize_legacy_vault(ctx: Context<InitializeLegacyVault>, seed: u64) -> Result<()> {
        initialize_vault_config(
            &mut ctx.accounts.vault_config,
            ctx.accounts.admin.key(),
            ctx.accounts.mint.key(),
            seed,
            ctx.bumps.vault_authority,
            LEGACY_VERSION,
        );
        Ok(())
    }

    pub fn initialize_vault(ctx: Context<InitializeVault>, seed: u64) -> Result<()> {
        initialize_vault_config(
            &mut ctx.accounts.vault_config,
            ctx.accounts.admin.key(),
            ctx.accounts.mint.key(),
            seed,
            ctx.bumps.vault_authority,
            CURRENT_VERSION,
        );
        Ok(())
    }

    pub fn migrate_vault(ctx: Context<MigrateVault>) -> Result<()> {
        let vault_config = &mut ctx.accounts.vault_config;
        vault_config.version = CURRENT_VERSION;
        vault_config.paused = false;
        vault_config.total_withdrawn = 0;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultMigrationError::AmountMustBePositive);

        let vault_config = &mut ctx.accounts.vault_config;
        if vault_config.version == CURRENT_VERSION {
            require!(!vault_config.paused, VaultMigrationError::VaultPaused);
        }

        let receipt = &mut ctx.accounts.receipt;
        if receipt.owner == Pubkey::default() {
            receipt.version = vault_config.version;
            receipt.vault_config = vault_config.key();
            receipt.owner = ctx.accounts.user.key();
            receipt.balance = 0;
            receipt.withdrawn_total = 0;
        } else {
            assert_receipt_matches(receipt, vault_config.key(), ctx.accounts.user.key())?;
            if vault_config.version == CURRENT_VERSION && receipt.version != CURRENT_VERSION {
                return err!(VaultMigrationError::ReceiptNeedsMigration);
            }
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
            .ok_or(VaultMigrationError::MathOverflow)?;
        vault_config.total_deposited = vault_config
            .total_deposited
            .checked_add(amount)
            .ok_or(VaultMigrationError::MathOverflow)?;
        Ok(())
    }

    pub fn migrate_receipt(ctx: Context<MigrateReceipt>) -> Result<()> {
        let vault_config = &ctx.accounts.vault_config;
        require!(
            vault_config.version == CURRENT_VERSION,
            VaultMigrationError::VaultNeedsMigration
        );

        let receipt = &mut ctx.accounts.receipt;
        receipt.owner = ctx.accounts.user.key();
        receipt.version = CURRENT_VERSION;
        receipt.withdrawn_total = 0;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultMigrationError::AmountMustBePositive);

        let vault_config = &mut ctx.accounts.vault_config;
        require!(
            vault_config.version == CURRENT_VERSION,
            VaultMigrationError::VaultNeedsMigration
        );
        require!(!vault_config.paused, VaultMigrationError::VaultPaused);

        let receipt = &mut ctx.accounts.receipt;
        require!(
            receipt.balance >= amount,
            VaultMigrationError::InsufficientBalance
        );

        let vault_key = vault_config.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_AUTHORITY_SEED,
            vault_key.as_ref(),
            &[vault_config.vault_authority_bump],
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

        receipt.balance = receipt
            .balance
            .checked_sub(amount)
            .ok_or(VaultMigrationError::MathOverflow)?;
        receipt.withdrawn_total = receipt
            .withdrawn_total
            .checked_add(amount)
            .ok_or(VaultMigrationError::MathOverflow)?;
        vault_config.total_withdrawn = vault_config
            .total_withdrawn
            .checked_add(amount)
            .ok_or(VaultMigrationError::MathOverflow)?;
        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        let vault_config = &mut ctx.accounts.vault_config;
        require!(
            vault_config.version == CURRENT_VERSION,
            VaultMigrationError::VaultNeedsMigration
        );
        vault_config.paused = paused;
        Ok(())
    }
}

fn initialize_vault_config(
    vault_config: &mut Account<VaultConfig>,
    admin: Pubkey,
    mint: Pubkey,
    seed: u64,
    vault_authority_bump: u8,
    version: u8,
) {
    vault_config.version = version;
    vault_config.seed = seed;
    vault_config.admin = admin;
    vault_config.mint = mint;
    vault_config.vault_authority_bump = vault_authority_bump;
    vault_config.paused = false;
    vault_config.total_deposited = 0;
    vault_config.total_withdrawn = 0;
}

fn assert_receipt_matches(receipt: &Account<Receipt>, vault_config: Pubkey, owner: Pubkey) -> Result<()> {
    require_keys_eq!(
        receipt.vault_config,
        vault_config,
        VaultMigrationError::InvalidReceipt
    );
    require_keys_eq!(
        receipt.owner,
        owner,
        VaultMigrationError::InvalidReceiptOwner
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct InitializeLegacyVault<'info> {
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
#[instruction(seed: u64)]
pub struct InitializeVault<'info> {
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
pub struct MigrateVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.admin.as_ref(), &vault_config.seed.to_le_bytes()],
        bump
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.admin.as_ref(), &vault_config.seed.to_le_bytes()],
        bump,
        has_one = mint @ VaultMigrationError::InvalidMint
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
pub struct MigrateReceipt<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.admin.as_ref(), &vault_config.seed.to_le_bytes()],
        bump
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(mut)]
    pub receipt: Account<'info, Receipt>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault_config.admin.as_ref(), &vault_config.seed.to_le_bytes()],
        bump,
        has_one = mint @ VaultMigrationError::InvalidMint
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
    #[account(mut, token::mint = mint)]
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
        bump,
        constraint = vault_config.admin == admin.key() @ VaultMigrationError::UnauthorizedAdmin
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub version: u8,
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
    pub version: u8,
    pub vault_config: Pubkey,
    pub owner: Pubkey,
    pub balance: u64,
    pub withdrawn_total: u64,
}

#[error_code]
pub enum VaultMigrationError {
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
    #[msg("The vault config must be migrated to the current version first.")]
    VaultNeedsMigration,
    #[msg("The receipt must be migrated to the current version first.")]
    ReceiptNeedsMigration,
    #[msg("The account version is not valid for this operation.")]
    InvalidVersion,
    #[msg("Arithmetic overflowed during accounting updates.")]
    MathOverflow,
}
