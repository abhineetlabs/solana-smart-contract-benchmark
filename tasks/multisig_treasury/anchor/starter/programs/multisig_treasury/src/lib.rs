use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

declare_id!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

const MULTISIG_SEED: &[u8] = b"multisig";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
const PROPOSAL_SEED: &[u8] = b"proposal";

#[program]
pub mod multisig_treasury {
    use super::*;

    pub fn initialize(
        _ctx: Context<Initialize>,
        seed: u64,
        owners: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        let _ = (seed, owners, threshold);
        todo!("validate the owner set, store thresholded multisig state, and record the treasury vault authority bump");
    }

    pub fn propose_transfer(
        _ctx: Context<ProposeTransfer>,
        proposal_id: u64,
        amount: u64,
    ) -> Result<()> {
        let _ = (proposal_id, amount);
        todo!("create a proposal PDA, bind the intended recipient and amount, and count the proposer as approved");
    }

    pub fn approve(_ctx: Context<Approve>) -> Result<()> {
        todo!("record one approval per owner and reject duplicate votes");
    }

    pub fn execute(_ctx: Context<Execute>) -> Result<()> {
        todo!("enforce threshold, validate the recipient payout account, transfer treasury funds, and close the proposal");
    }
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = creator,
        space = 8 + Multisig::INIT_SPACE,
        seeds = [MULTISIG_SEED, creator.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub multisig: Account<'info, Multisig>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, multisig.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ProposeTransfer<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(
        mut,
        seeds = [MULTISIG_SEED, multisig.creator.as_ref(), &multisig.seed.to_le_bytes()],
        bump
    )]
    pub multisig: Account<'info, Multisig>,
    #[account(
        init,
        payer = proposer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, multisig.key().as_ref(), &proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    pub recipient: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [MULTISIG_SEED, multisig.creator.as_ref(), &multisig.seed.to_le_bytes()],
        bump
    )]
    pub multisig: Account<'info, Multisig>,
    #[account(
        mut,
        seeds = [PROPOSAL_SEED, multisig.key().as_ref(), &proposal.id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [MULTISIG_SEED, multisig.creator.as_ref(), &multisig.seed.to_le_bytes()],
        bump,
        has_one = mint @ MultisigError::InvalidMint
    )]
    pub multisig: Account<'info, Multisig>,
    #[account(
        mut,
        close = owner,
        seeds = [PROPOSAL_SEED, multisig.key().as_ref(), &proposal.id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, multisig.key().as_ref()],
        bump = multisig.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    pub recipient: SystemAccount<'info>,
    #[account(
        mut,
        token::mint = mint
    )]
    pub recipient_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Multisig {
    pub seed: u64,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub threshold: u8,
    pub vault_authority_bump: u8,
    pub next_proposal_id: u64,
    #[max_len(5)]
    pub owners: Vec<Pubkey>,
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub multisig: Pubkey,
    pub id: u64,
    pub recipient: Pubkey,
    pub amount: u64,
    #[max_len(5)]
    pub approvals: Vec<bool>,
}

#[error_code]
pub enum MultisigError {
    #[msg("The provided threshold is invalid for the owner set.")]
    InvalidThreshold,
    #[msg("Owners must be unique and non-default.")]
    DuplicateOwner,
    #[msg("The signer is not an owner in this multisig.")]
    InvalidOwner,
    #[msg("Proposal amounts must be positive.")]
    AmountMustBePositive,
    #[msg("The proposal does not match the expected multisig state.")]
    InvalidProposal,
    #[msg("The treasury mint does not match.")]
    InvalidMint,
    #[msg("The recipient does not match the proposal.")]
    InvalidRecipient,
    #[msg("The recipient token account is invalid.")]
    InvalidRecipientToken,
    #[msg("This owner has already approved the proposal.")]
    DuplicateApproval,
    #[msg("The proposal does not have enough approvals to execute.")]
    ThresholdNotMet,
}
