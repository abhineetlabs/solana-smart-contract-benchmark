use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

const MULTISIG_SEED: &[u8] = b"multisig";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
const PROPOSAL_SEED: &[u8] = b"proposal";
const MAX_OWNERS: usize = 5;

#[program]
pub mod multisig_treasury {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        seed: u64,
        owners: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        validate_owner_set(&owners, threshold)?;

        let multisig = &mut ctx.accounts.multisig;
        multisig.seed = seed;
        multisig.creator = ctx.accounts.creator.key();
        multisig.mint = ctx.accounts.mint.key();
        multisig.threshold = threshold;
        multisig.vault_authority_bump = ctx.bumps.vault_authority;
        multisig.next_proposal_id = 0;
        multisig.owners = owners;
        Ok(())
    }

    pub fn propose_transfer(
        ctx: Context<ProposeTransfer>,
        proposal_id: u64,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, MultisigError::AmountMustBePositive);
        require!(
            proposal_id == ctx.accounts.multisig.next_proposal_id,
            MultisigError::InvalidProposal
        );

        let proposer_index = owner_index(&ctx.accounts.multisig, ctx.accounts.proposer.key())?;
        let approvals_len = ctx.accounts.multisig.owners.len();

        let proposal = &mut ctx.accounts.proposal;
        proposal.multisig = ctx.accounts.multisig.key();
        proposal.id = proposal_id;
        proposal.recipient = ctx.accounts.recipient.key();
        proposal.amount = amount;
        proposal.approvals = vec![false; approvals_len];
        proposal.approvals[proposer_index] = true;

        ctx.accounts.multisig.next_proposal_id = ctx
            .accounts
            .multisig
            .next_proposal_id
            .checked_add(1)
            .ok_or(error!(MultisigError::InvalidProposal))?;

        Ok(())
    }

    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.proposal.multisig,
            ctx.accounts.multisig.key(),
            MultisigError::InvalidProposal
        );

        let owner_index = owner_index(&ctx.accounts.multisig, ctx.accounts.owner.key())?;
        require!(
            !ctx.accounts.proposal.approvals[owner_index],
            MultisigError::DuplicateApproval
        );
        ctx.accounts.proposal.approvals[owner_index] = true;
        Ok(())
    }

    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.proposal.multisig,
            ctx.accounts.multisig.key(),
            MultisigError::InvalidProposal
        );
        let _ = owner_index(&ctx.accounts.multisig, ctx.accounts.owner.key())?;
        require!(
            approval_count(&ctx.accounts.proposal) >= ctx.accounts.multisig.threshold as usize,
            MultisigError::ThresholdNotMet
        );
        require_keys_eq!(
            ctx.accounts.proposal.recipient,
            ctx.accounts.recipient.key(),
            MultisigError::InvalidRecipient
        );
        require_keys_eq!(
            ctx.accounts.recipient_token.owner,
            ctx.accounts.recipient.key(),
            MultisigError::InvalidRecipientToken
        );
        require_keys_eq!(
            ctx.accounts.recipient_token.mint,
            ctx.accounts.mint.key(),
            MultisigError::InvalidRecipientToken
        );

        let multisig_key = ctx.accounts.multisig.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_AUTHORITY_SEED,
            multisig_key.as_ref(),
            &[ctx.accounts.multisig.vault_authority_bump],
        ]];

        let transfer_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
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
            ctx.accounts.proposal.amount,
            ctx.accounts.mint.decimals,
        )
    }
}

fn validate_owner_set(owners: &[Pubkey], threshold: u8) -> Result<()> {
    require!(
        !owners.is_empty() && owners.len() <= MAX_OWNERS,
        MultisigError::InvalidThreshold
    );
    require!(
        threshold > 0 && (threshold as usize) <= owners.len(),
        MultisigError::InvalidThreshold
    );

    for (index, owner) in owners.iter().enumerate() {
        require!(*owner != Pubkey::default(), MultisigError::DuplicateOwner);
        for other_owner in owners.iter().skip(index + 1) {
            require!(*owner != *other_owner, MultisigError::DuplicateOwner);
        }
    }

    Ok(())
}

fn owner_index(multisig: &Multisig, owner: Pubkey) -> Result<usize> {
    multisig
        .owners
        .iter()
        .position(|candidate| *candidate == owner)
        .ok_or_else(|| error!(MultisigError::InvalidOwner))
}

fn approval_count(proposal: &Proposal) -> usize {
    proposal.approvals.iter().filter(|approved| **approved).count()
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
