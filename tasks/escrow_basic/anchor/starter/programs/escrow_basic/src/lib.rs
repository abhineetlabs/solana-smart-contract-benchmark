use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

declare_id!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

const ESCROW_SEED: &[u8] = b"escrow";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";

#[program]
pub mod escrow_basic {
    use super::*;

    pub fn initialize(
        _ctx: Context<Initialize>,
        seed: u64,
        offered_amount: u64,
        desired_amount: u64,
    ) -> Result<()> {
        let _ = (seed, offered_amount, desired_amount);
        todo!("store escrow state, derive bumps, and transfer maker funds into the vault");
    }

    pub fn exchange(_ctx: Context<Exchange>) -> Result<()> {
        todo!("validate escrow accounts, transfer both sides of the swap, and close escrow resources");
    }

    pub fn cancel(_ctx: Context<Cancel>) -> Result<()> {
        todo!("validate the maker, return vault funds, and close escrow resources");
    }
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
