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
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    seed: u64,
    offered_amount: u64,
    desired_amount: u64,
) -> ProgramResult {
    let mut account_iter = accounts.iter();
    let maker_info = next_signer(&mut account_iter)?;
    let offered_mint_info = next_account_info(&mut account_iter)?;
    let desired_mint_info = next_account_info(&mut account_iter)?;
    let escrow_info = next_account_info(&mut account_iter)?;
    let vault_authority_info = next_account_info(&mut account_iter)?;
    let maker_offered_token_info = next_account_info(&mut account_iter)?;
    let vault_info = next_account_info(&mut account_iter)?;
    let token_program_info = next_account_info(&mut account_iter)?;
    let system_program_info = next_account_info(&mut account_iter)?;

    validate_program_account(
        token_program_info,
        &spl_token::id(),
        EscrowError::InvalidTokenProgram,
    )?;
    validate_program_account(
        system_program_info,
        &system_program::id(),
        EscrowError::InvalidSystemProgram,
    )?;

    load_mint(offered_mint_info)?;
    load_mint(desired_mint_info)?;

    let (expected_escrow, escrow_bump) = derive_escrow(maker_info.key, seed, program_id);
    if expected_escrow != *escrow_info.key {
        return Err(EscrowError::InvalidSeeds.into());
    }

    let (expected_vault_authority, vault_authority_bump) =
        derive_vault_authority(escrow_info.key, program_id);
    if expected_vault_authority != *vault_authority_info.key {
        return Err(EscrowError::InvalidVaultAuthority.into());
    }

    if escrow_info.lamports() > 0 {
        return Err(EscrowError::AlreadyInitialized.into());
    }

    create_pda_account(
        maker_info,
        escrow_info,
        system_program_info,
        program_id,
        EscrowState::LEN,
        &[
            ESCROW_SEED,
            maker_info.key.as_ref(),
            &seed.to_le_bytes(),
            &[escrow_bump],
        ],
    )?;

    let maker_offered_token = load_token_account(maker_offered_token_info)?;
    if maker_offered_token.owner != *maker_info.key
        || maker_offered_token.mint != *offered_mint_info.key
    {
        return Err(EscrowError::InvalidMakerTokenAccount.into());
    }

    let vault_token = load_token_account(vault_info)?;
    if vault_token.owner != *vault_authority_info.key || vault_token.mint != *offered_mint_info.key
    {
        return Err(EscrowError::InvalidVault.into());
    }

    let transfer_instruction = spl_token::instruction::transfer_checked(
        &spl_token::id(),
        maker_offered_token_info.key,
        offered_mint_info.key,
        vault_info.key,
        maker_info.key,
        &[],
        offered_amount,
        load_mint(offered_mint_info)?.decimals,
    )?;
    invoke(
        &transfer_instruction,
        &[
            maker_offered_token_info.clone(),
            offered_mint_info.clone(),
            vault_info.clone(),
            maker_info.clone(),
            token_program_info.clone(),
        ],
    )?;

    let escrow = EscrowState {
        is_initialized: true,
        seed,
        maker: *maker_info.key,
        offered_mint: *offered_mint_info.key,
        desired_mint: *desired_mint_info.key,
        offered_amount,
        desired_amount,
        vault_authority_bump,
    };
    store_escrow(escrow_info, &escrow)
}

fn exchange(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let mut account_iter = accounts.iter();
    let taker_info = next_signer(&mut account_iter)?;
    let maker_info = next_account_info(&mut account_iter)?;
    let escrow_info = next_account_info(&mut account_iter)?;
    let vault_authority_info = next_account_info(&mut account_iter)?;
    let offered_mint_info = next_account_info(&mut account_iter)?;
    let desired_mint_info = next_account_info(&mut account_iter)?;
    let vault_info = next_account_info(&mut account_iter)?;
    let maker_receive_token_info = next_account_info(&mut account_iter)?;
    let taker_deposit_token_info = next_account_info(&mut account_iter)?;
    let taker_receive_token_info = next_account_info(&mut account_iter)?;
    let token_program_info = next_account_info(&mut account_iter)?;

    validate_program_account(
        token_program_info,
        &spl_token::id(),
        EscrowError::InvalidTokenProgram,
    )?;

    let escrow = load_escrow(escrow_info)?;
    if escrow_info.owner != program_id {
        return Err(EscrowError::InvalidOwner.into());
    }

    let (expected_escrow, _) = derive_escrow(&escrow.maker, escrow.seed, program_id);
    if expected_escrow != *escrow_info.key {
        return Err(EscrowError::InvalidEscrow.into());
    }

    let (expected_vault_authority, _) = derive_vault_authority(escrow_info.key, program_id);
    if expected_vault_authority != *vault_authority_info.key {
        return Err(EscrowError::InvalidVaultAuthority.into());
    }

    if escrow.vault_authority_bump != derive_vault_authority(escrow_info.key, program_id).1 {
        return Err(EscrowError::InvalidVaultAuthority.into());
    }
    if escrow.offered_mint != *offered_mint_info.key
    {
        return Err(EscrowError::InvalidMint.into());
    }

    let offered_mint = load_mint(offered_mint_info)?;
    let desired_mint = load_mint(desired_mint_info)?;
    let vault_token = load_token_account(vault_info)?;
    if vault_token.owner != *vault_authority_info.key || vault_token.mint != *offered_mint_info.key
    {
        return Err(EscrowError::InvalidVault.into());
    }

    load_token_account(maker_receive_token_info)?;

    let taker_deposit_token = load_token_account(taker_deposit_token_info)?;
    if taker_deposit_token.owner != *taker_info.key
        || taker_deposit_token.mint != *desired_mint_info.key
    {
        return Err(EscrowError::InvalidTakerTokenAccount.into());
    }

    load_token_account(taker_receive_token_info)?;

    let maker_transfer_instruction = spl_token::instruction::transfer_checked(
        &spl_token::id(),
        taker_deposit_token_info.key,
        desired_mint_info.key,
        maker_receive_token_info.key,
        taker_info.key,
        &[],
        escrow.desired_amount,
        desired_mint.decimals,
    )?;
    invoke(
        &maker_transfer_instruction,
        &[
            taker_deposit_token_info.clone(),
            desired_mint_info.clone(),
            maker_receive_token_info.clone(),
            taker_info.clone(),
            token_program_info.clone(),
        ],
    )?;

    let signer_seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        escrow_info.key.as_ref(),
        &[escrow.vault_authority_bump],
    ];
    let taker_transfer_instruction = spl_token::instruction::transfer_checked(
        &spl_token::id(),
        vault_info.key,
        offered_mint_info.key,
        taker_receive_token_info.key,
        vault_authority_info.key,
        &[],
        escrow.offered_amount,
        offered_mint.decimals,
    )?;
    invoke_signed(
        &taker_transfer_instruction,
        &[
            vault_info.clone(),
            offered_mint_info.clone(),
            taker_receive_token_info.clone(),
            vault_authority_info.clone(),
            token_program_info.clone(),
        ],
        &[signer_seeds],
    )?;

    close_token_account(
        vault_info,
        maker_info,
        vault_authority_info,
        token_program_info,
        signer_seeds,
    )?;
    close_program_account(escrow_info, maker_info)
}

fn cancel(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let mut account_iter = accounts.iter();
    let maker_info = next_signer(&mut account_iter)?;
    let escrow_info = next_account_info(&mut account_iter)?;
    let vault_authority_info = next_account_info(&mut account_iter)?;
    let offered_mint_info = next_account_info(&mut account_iter)?;
    let vault_info = next_account_info(&mut account_iter)?;
    let maker_receive_token_info = next_account_info(&mut account_iter)?;
    let token_program_info = next_account_info(&mut account_iter)?;

    validate_program_account(
        token_program_info,
        &spl_token::id(),
        EscrowError::InvalidTokenProgram,
    )?;

    let escrow = load_escrow(escrow_info)?;
    if escrow_info.owner != program_id {
        return Err(EscrowError::InvalidOwner.into());
    }

    let (expected_escrow, _) = derive_escrow(&escrow.maker, escrow.seed, program_id);
    if expected_escrow != *escrow_info.key {
        return Err(EscrowError::InvalidEscrow.into());
    }

    let (expected_vault_authority, _) = derive_vault_authority(escrow_info.key, program_id);
    if expected_vault_authority != *vault_authority_info.key {
        return Err(EscrowError::InvalidVaultAuthority.into());
    }

    if escrow.offered_mint != *offered_mint_info.key {
        return Err(EscrowError::InvalidMint.into());
    }

    let offered_mint = load_mint(offered_mint_info)?;
    let vault_token = load_token_account(vault_info)?;
    if vault_token.owner != *vault_authority_info.key || vault_token.mint != *offered_mint_info.key
    {
        return Err(EscrowError::InvalidVault.into());
    }

    load_token_account(maker_receive_token_info)?;

    let signer_seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        escrow_info.key.as_ref(),
        &[escrow.vault_authority_bump],
    ];
    let transfer_instruction = spl_token::instruction::transfer_checked(
        &spl_token::id(),
        vault_info.key,
        offered_mint_info.key,
        maker_receive_token_info.key,
        vault_authority_info.key,
        &[],
        escrow.offered_amount,
        offered_mint.decimals,
    )?;
    invoke_signed(
        &transfer_instruction,
        &[
            vault_info.clone(),
            offered_mint_info.clone(),
            maker_receive_token_info.clone(),
            vault_authority_info.clone(),
            token_program_info.clone(),
        ],
        &[signer_seeds],
    )?;

    close_token_account(
        vault_info,
        maker_info,
        vault_authority_info,
        token_program_info,
        signer_seeds,
    )?;
    close_program_account(escrow_info, maker_info)
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
