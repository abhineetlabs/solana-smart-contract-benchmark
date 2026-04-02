use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
};

pub const ID: Pubkey = pubkey!("4SzyBJeg5FtuF6Y7qD2h6H8QRzjGUywJYKkPY33YatXu");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub enum CounterInstruction {
    Initialize,
    Increment,
    SetAuthority { new_authority: Pubkey },
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct CounterAccount {
    pub is_initialized: bool,
    pub authority: Pubkey,
    pub count: u64,
}

impl CounterAccount {
    pub const LEN: usize = 1 + 32 + 8;
}

#[repr(u32)]
pub enum CounterError {
    InvalidInstruction = 0,
    MissingSignature = 1,
    Unauthorized = 2,
    Overflow = 3,
    AlreadyInitialized = 4,
    InvalidOwner = 5,
}

impl From<CounterError> for ProgramError {
    fn from(error: CounterError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    input: &[u8],
) -> ProgramResult {
    let instruction = CounterInstruction::try_from_slice(input)
        .map_err(|_| CounterError::InvalidInstruction)?;

    match instruction {
        CounterInstruction::Initialize => initialize(program_id, accounts),
        CounterInstruction::Increment => increment(program_id, accounts),
        CounterInstruction::SetAuthority { new_authority } => {
            set_authority(program_id, accounts, new_authority)
        }
    }
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    msg!("initialize");

    let mut account_iter = accounts.iter();
    let counter_info = next_account_info(&mut account_iter)?;
    let authority_info = next_account_info(&mut account_iter)?;
    if !authority_info.is_signer {
        return Err(CounterError::MissingSignature.into());
    }

    if counter_info.owner != program_id {
        return Err(CounterError::InvalidOwner.into());
    }

    let mut counter = load_counter(counter_info)?;
    if counter.is_initialized {
        return Err(CounterError::AlreadyInitialized.into());
    }

    counter.is_initialized = true;
    counter.authority = *authority_info.key;
    counter.count = 0;
    store_counter(counter_info, &counter)
}

fn increment(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    msg!("increment");

    let mut account_iter = accounts.iter();
    let counter_info = next_account_info(&mut account_iter)?;
    let authority_info = next_account_info(&mut account_iter)?;
    if !authority_info.is_signer {
        return Err(CounterError::MissingSignature.into());
    }

    if counter_info.owner != program_id {
        return Err(CounterError::InvalidOwner.into());
    }

    let mut counter = load_counter(counter_info)?;
    counter.count = counter
        .count
        .checked_add(1)
        .ok_or(CounterError::Overflow)?;
    store_counter(counter_info, &counter)
}

fn set_authority(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_authority: Pubkey,
) -> ProgramResult {
    msg!("set_authority");

    let mut account_iter = accounts.iter();
    let counter_info = next_account_info(&mut account_iter)?;
    let authority_info = next_account_info(&mut account_iter)?;
    if !authority_info.is_signer {
        return Err(CounterError::MissingSignature.into());
    }

    if counter_info.owner != program_id {
        return Err(CounterError::InvalidOwner.into());
    }

    let mut counter = load_counter(counter_info)?;
    counter.authority = new_authority;
    store_counter(counter_info, &counter)
}

fn load_counter(counter_info: &AccountInfo) -> Result<CounterAccount, ProgramError> {
    let data = counter_info.try_borrow_data()?;
    CounterAccount::try_from_slice(&data).map_err(|_| ProgramError::InvalidAccountData)
}

fn store_counter(counter_info: &AccountInfo, counter: &CounterAccount) -> ProgramResult {
    counter
        .serialize(&mut &mut counter_info.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)
}
