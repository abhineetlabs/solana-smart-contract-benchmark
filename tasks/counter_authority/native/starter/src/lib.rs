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

fn initialize(_program_id: &Pubkey, _accounts: &[AccountInfo]) -> ProgramResult {
    msg!("initialize");
    todo!("store the signer as authority and reset the counter state");
}

fn increment(_program_id: &Pubkey, _accounts: &[AccountInfo]) -> ProgramResult {
    msg!("increment");
    todo!("require the stored authority signer and increment the counter");
}

fn set_authority(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    new_authority: Pubkey,
) -> ProgramResult {
    let _ = new_authority;
    msg!("set_authority");
    todo!("require the stored authority signer and update the authority pubkey");
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

fn next_signer<'a>(
    account_iter: &mut std::slice::Iter<'a, AccountInfo<'a>>,
) -> Result<&'a AccountInfo<'a>, ProgramError> {
    let signer = next_account_info(account_iter)?;
    if !signer.is_signer {
        return Err(CounterError::MissingSignature.into());
    }
    Ok(signer)
}
