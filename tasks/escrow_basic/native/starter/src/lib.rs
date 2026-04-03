use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_token::state::{Account as TokenAccount, Mint};

pub const ID: Pubkey = pubkey!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub enum EscrowInstruction {
    Initialize {
        seed: u64,
        offered_amount: u64,
        desired_amount: u64,
    },
    Exchange,
    Cancel,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct EscrowState {
    pub is_initialized: bool,
    pub seed: u64,
    pub maker: Pubkey,
    pub offered_mint: Pubkey,
    pub desired_mint: Pubkey,
    pub offered_amount: u64,
    pub desired_amount: u64,
    pub vault_authority_bump: u8,
}

impl EscrowState {
    pub const LEN: usize = 1 + 8 + 32 + 32 + 32 + 8 + 8 + 1;
}

#[repr(u32)]
pub enum EscrowError {
    InvalidInstruction = 0,
    MissingSignature = 1,
    InvalidOwner = 2,
    InvalidSeeds = 3,
    AlreadyInitialized = 4,
    NotInitialized = 5,
    InvalidMaker = 6,
    InvalidMint = 7,
    InvalidMakerTokenAccount = 8,
    InvalidTakerTokenAccount = 9,
    InvalidVault = 10,
    InvalidVaultAuthority = 11,
    InvalidEscrow = 12,
    InvalidTokenProgram = 13,
    InvalidSystemProgram = 14,
    AmountMustBePositive = 15,
    Overflow = 16,
}

impl From<EscrowError> for ProgramError {
    fn from(error: EscrowError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    input: &[u8],
) -> ProgramResult {
    let instruction =
        EscrowInstruction::try_from_slice(input).map_err(|_| EscrowError::InvalidInstruction)?;

    match instruction {
        EscrowInstruction::Initialize {
            seed,
            offered_amount,
            desired_amount,
        } => initialize(program_id, accounts, seed, offered_amount, desired_amount),
        EscrowInstruction::Exchange => exchange(program_id, accounts),
        EscrowInstruction::Cancel => cancel(program_id, accounts),
    }
}

fn initialize(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    seed: u64,
    offered_amount: u64,
    desired_amount: u64,
) -> ProgramResult {
    let _ = (seed, offered_amount, desired_amount);
    todo!(
        "create the escrow PDA, validate the offered/desired mints and the pre-created vault account, and transfer the maker deposit into custody"
    );
}

fn exchange(_program_id: &Pubkey, _accounts: &[AccountInfo]) -> ProgramResult {
    todo!(
        "validate the maker binding and token accounts, move desired tokens from taker to maker, release offered tokens with the vault PDA signer, and close the escrow"
    );
}

fn cancel(_program_id: &Pubkey, _accounts: &[AccountInfo]) -> ProgramResult {
    todo!(
        "allow only the stored maker to reclaim the offered asset from the vault and close the escrow cleanly"
    );
}

pub fn derive_escrow(maker: &Pubkey, seed: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ESCROW_SEED, maker.as_ref(), &seed.to_le_bytes()], program_id)
}

pub fn derive_vault_authority(escrow: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED, escrow.as_ref()], program_id)
}

pub fn create_pda_account<'a>(
    payer_info: &AccountInfo<'a>,
    new_account_info: &AccountInfo<'a>,
    system_program_info: &AccountInfo<'a>,
    owner: &Pubkey,
    space: usize,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    let lamports = Rent::get()?.minimum_balance(space);
    let instruction = system_instruction::create_account(
        payer_info.key,
        new_account_info.key,
        lamports,
        space as u64,
        owner,
    );
    invoke_signed(
        &instruction,
        &[
            payer_info.clone(),
            new_account_info.clone(),
            system_program_info.clone(),
        ],
        &[signer_seeds],
    )
}

pub fn close_program_account(
    source_info: &AccountInfo,
    destination_info: &AccountInfo,
) -> ProgramResult {
    let source_lamports = source_info.lamports();
    let updated_destination = destination_info
        .lamports()
        .checked_add(source_lamports)
        .ok_or(EscrowError::Overflow)?;
    **destination_info.try_borrow_mut_lamports()? = updated_destination;
    **source_info.try_borrow_mut_lamports()? = 0;
    source_info.assign(&system_program::id());
    source_info.realloc(0, false)?;
    Ok(())
}

pub fn close_token_account<'a>(
    account_info: &AccountInfo<'a>,
    destination_info: &AccountInfo<'a>,
    authority_info: &AccountInfo<'a>,
    token_program_info: &AccountInfo<'a>,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    let instruction = spl_token::instruction::close_account(
        &spl_token::id(),
        account_info.key,
        destination_info.key,
        authority_info.key,
        &[],
    )?;
    invoke_signed(
        &instruction,
        &[
            account_info.clone(),
            destination_info.clone(),
            authority_info.clone(),
            token_program_info.clone(),
        ],
        &[signer_seeds],
    )
}

pub fn load_escrow(escrow_info: &AccountInfo) -> Result<EscrowState, ProgramError> {
    let data = escrow_info.try_borrow_data()?;
    let escrow = EscrowState::try_from_slice(&data).map_err(|_| ProgramError::InvalidAccountData)?;
    if !escrow.is_initialized {
        return Err(EscrowError::NotInitialized.into());
    }
    Ok(escrow)
}

pub fn store_escrow(escrow_info: &AccountInfo, escrow: &EscrowState) -> ProgramResult {
    escrow
        .serialize(&mut &mut escrow_info.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)
}

pub fn load_token_account(token_account_info: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if token_account_info.owner != &spl_token::id() {
        return Err(EscrowError::InvalidOwner.into());
    }
    TokenAccount::unpack(&token_account_info.try_borrow_data()?)
        .map_err(|_| ProgramError::InvalidAccountData)
}

pub fn load_mint(mint_info: &AccountInfo) -> Result<Mint, ProgramError> {
    if mint_info.owner != &spl_token::id() {
        return Err(EscrowError::InvalidMint.into());
    }
    Mint::unpack(&mint_info.try_borrow_data()?).map_err(|_| ProgramError::InvalidAccountData)
}

pub fn next_signer<'a, 'b>(
    account_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
) -> Result<&'a AccountInfo<'b>, ProgramError> {
    let account_info = next_account_info(account_iter)?;
    if !account_info.is_signer {
        return Err(EscrowError::MissingSignature.into());
    }
    Ok(account_info)
}

pub fn validate_program_account(
    account_info: &AccountInfo,
    expected_program: &Pubkey,
    error: EscrowError,
) -> ProgramResult {
    if account_info.key != expected_program {
        return Err(error.into());
    }
    Ok(())
}
