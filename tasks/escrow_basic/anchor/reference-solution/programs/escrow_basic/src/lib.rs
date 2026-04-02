use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

const ESCROW_SEED: &[u8] = b"escrow";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";

#[program]
pub mod escrow_basic {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        seed: u64,
        offered_amount: u64,
        desired_amount: u64,
    ) -> Result<()> {
        require!(offered_amount > 0, EscrowError::AmountMustBePositive);
        require!(desired_amount > 0, EscrowError::AmountMustBePositive);

        let escrow = &mut ctx.accounts.escrow;
        escrow.seed = seed;
        escrow.maker = ctx.accounts.maker.key();
        escrow.offered_mint = ctx.accounts.offered_mint.key();
        escrow.desired_mint = ctx.accounts.desired_mint.key();
        escrow.offered_amount = offered_amount;
        escrow.desired_amount = desired_amount;
        escrow.vault_authority_bump = ctx.bumps.vault_authority;

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.maker_offered_token.to_account_info(),
            mint: ctx.accounts.offered_mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.maker.to_account_info(),
        };

        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_accounts),
            offered_amount,
            ctx.accounts.offered_mint.decimals,
        )
    }

    pub fn exchange(ctx: Context<Exchange>) -> Result<()> {
        validate_exchange(&ctx)?;

        let maker_receive_accounts = TransferChecked {
            from: ctx.accounts.taker_deposit_token.to_account_info(),
            mint: ctx.accounts.desired_mint.to_account_info(),
            to: ctx.accounts.maker_receive_token.to_account_info(),
            authority: ctx.accounts.taker.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), maker_receive_accounts),
            ctx.accounts.escrow.desired_amount,
            ctx.accounts.desired_mint.decimals,
        )?;

        let escrow_key = ctx.accounts.escrow.key();
        let vault_signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_AUTHORITY_SEED,
            escrow_key.as_ref(),
            &[ctx.accounts.escrow.vault_authority_bump],
        ]];

        let taker_receive_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.offered_mint.to_account_info(),
            to: ctx.accounts.taker_receive_token.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                taker_receive_accounts,
                vault_signer_seeds,
            ),
            ctx.accounts.escrow.offered_amount,
            ctx.accounts.offered_mint.decimals,
        )?;

        let close_accounts = CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.maker.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_accounts,
            vault_signer_seeds,
        ))
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        validate_cancel(&ctx)?;

        let escrow_key = ctx.accounts.escrow.key();
        let vault_signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_AUTHORITY_SEED,
            escrow_key.as_ref(),
            &[ctx.accounts.escrow.vault_authority_bump],
        ]];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.offered_mint.to_account_info(),
            to: ctx.accounts.maker_receive_token.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                transfer_accounts,
                vault_signer_seeds,
            ),
            ctx.accounts.escrow.offered_amount,
            ctx.accounts.offered_mint.decimals,
        )?;

        let close_accounts = CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.maker.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_accounts,
            vault_signer_seeds,
        ))
    }
}

fn validate_exchange(ctx: &Context<Exchange>) -> Result<()> {
    require_keys_eq!(ctx.accounts.escrow.maker, ctx.accounts.maker.key(), EscrowError::InvalidMaker);
    require_keys_eq!(
        ctx.accounts.escrow.offered_mint,
        ctx.accounts.offered_mint.key(),
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        ctx.accounts.escrow.desired_mint,
        ctx.accounts.desired_mint.key(),
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        ctx.accounts.maker_receive_token.owner,
        ctx.accounts.maker.key(),
        EscrowError::InvalidMakerTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.maker_receive_token.mint,
        ctx.accounts.desired_mint.key(),
        EscrowError::InvalidMakerTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.taker_deposit_token.owner,
        ctx.accounts.taker.key(),
        EscrowError::InvalidTakerTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.taker_deposit_token.mint,
        ctx.accounts.desired_mint.key(),
        EscrowError::InvalidTakerTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.taker_receive_token.owner,
        ctx.accounts.taker.key(),
        EscrowError::InvalidTakerTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.taker_receive_token.mint,
        ctx.accounts.offered_mint.key(),
        EscrowError::InvalidTakerTokenAccount
    );
    Ok(())
}

fn validate_cancel(ctx: &Context<Cancel>) -> Result<()> {
    require_keys_eq!(ctx.accounts.escrow.maker, ctx.accounts.maker.key(), EscrowError::InvalidMaker);
    require_keys_eq!(
        ctx.accounts.escrow.offered_mint,
        ctx.accounts.offered_mint.key(),
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        ctx.accounts.maker_receive_token.owner,
        ctx.accounts.maker.key(),
        EscrowError::InvalidMakerTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.maker_receive_token.mint,
        ctx.accounts.offered_mint.key(),
        EscrowError::InvalidMakerTokenAccount
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(
        init,
        payer = maker,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, maker.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, escrow.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub offered_mint: Account<'info, Mint>,
    pub desired_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = offered_mint,
        token::authority = maker
    )]
    pub maker_offered_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = maker,
        associated_token::mint = offered_mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Exchange<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    #[account(mut)]
    pub maker: SystemAccount<'info>,
    #[account(
        mut,
        close = maker,
        seeds = [ESCROW_SEED, escrow.maker.as_ref(), &escrow.seed.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, escrow.key().as_ref()],
        bump = escrow.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub offered_mint: Account<'info, Mint>,
    pub desired_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = offered_mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub maker_receive_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub taker_deposit_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub taker_receive_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(
        mut,
        close = maker,
        seeds = [ESCROW_SEED, escrow.maker.as_ref(), &escrow.seed.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, escrow.key().as_ref()],
        bump = escrow.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub offered_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = offered_mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub maker_receive_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub seed: u64,
    pub maker: Pubkey,
    pub offered_mint: Pubkey,
    pub desired_mint: Pubkey,
    pub offered_amount: u64,
    pub desired_amount: u64,
    pub vault_authority_bump: u8,
}

#[error_code]
pub enum EscrowError {
    #[msg("Escrow amounts must be positive.")]
    AmountMustBePositive,
    #[msg("The maker account does not match escrow state.")]
    InvalidMaker,
    #[msg("One or more token mints do not match escrow state.")]
    InvalidMint,
    #[msg("The maker token account is invalid.")]
    InvalidMakerTokenAccount,
    #[msg("The taker token account is invalid.")]
    InvalidTakerTokenAccount,
}
