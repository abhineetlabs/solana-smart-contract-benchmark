use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id, instruction::create_associated_token_account,
};
use spl_token::state::{Account as TokenAccount, Mint};

pub const ID: Pubkey = pubkey!("3BwUkQMtq1YmJ7JZvRdTZTQQY39mGnbfYbpEXRXsB7Mg");

pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
pub const RECEIPT_SEED: &[u8] = b"receipt";

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub enum VaultInstruction {
    Initialize { seed: u64 },
    Deposit { amount: u64 },
    Withdraw { amount: u64 },
    SetPaused { paused: bool },
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct VaultConfig {
    pub is_initialized: bool,
    pub seed: u64,
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub vault_authority_bump: u8,
    pub paused: bool,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
}

impl VaultConfig {
    pub const LEN: usize = 1 + 8 + 32 + 32 + 1 + 1 + 8 + 8;
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub is_initialized: bool,
    pub vault_config: Pubkey,
    pub owner: Pubkey,
    pub balance: u64,
}

impl Receipt {
    pub const LEN: usize = 1 + 32 + 32 + 8;
}

#[repr(u32)]
pub enum VaultError {
    InvalidInstruction = 0,
    MissingSignature = 1,
    InvalidOwner = 2,
    InvalidSeeds = 3,
    AlreadyInitialized = 4,
    NotInitialized = 5,
    VaultPaused = 6,
    UnauthorizedAdmin = 7,
    InvalidMint = 8,
    InvalidReceipt = 9,
    InvalidReceiptOwner = 10,
    InvalidTokenAccount = 11,
    InvalidTokenProgram = 12,
    InvalidAssociatedTokenProgram = 13,
    InvalidSystemProgram = 14,
    AmountMustBePositive = 15,
    InsufficientBalance = 16,
    Overflow = 17,
}

impl From<VaultError> for ProgramError {
    fn from(error: VaultError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    input: &[u8],
) -> ProgramResult {
    let instruction =
        VaultInstruction::try_from_slice(input).map_err(|_| VaultError::InvalidInstruction)?;

    match instruction {
        VaultInstruction::Initialize { seed } => initialize(program_id, accounts, seed),
        VaultInstruction::Deposit { amount } => deposit(program_id, accounts, amount),
        VaultInstruction::Withdraw { amount } => withdraw(program_id, accounts, amount),
        VaultInstruction::SetPaused { paused } => set_paused(program_id, accounts, paused),
    }
}

fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    seed: u64,
) -> ProgramResult {
    msg!("initialize");

    let mut account_iter = accounts.iter();
    let admin_info = next_signer(&mut account_iter)?;
    let mint_info = next_account_info(&mut account_iter)?;
    let vault_config_info = next_account_info(&mut account_iter)?;
    let vault_authority_info = next_account_info(&mut account_iter)?;
    let vault_info = next_account_info(&mut account_iter)?;
    let token_program_info = next_account_info(&mut account_iter)?;
    let _associated_token_program_info = next_account_info(&mut account_iter)?;
    let system_program_info = next_account_info(&mut account_iter)?;

    validate_program_account(
        token_program_info,
        &spl_token::id(),
        VaultError::InvalidTokenProgram,
    )?;
    validate_program_account(
        system_program_info,
        &system_program::id(),
        VaultError::InvalidSystemProgram,
    )?;
    load_mint(mint_info)?;

    let (expected_vault_config, vault_config_bump) =
        derive_vault_config(admin_info.key, seed, program_id);
    if expected_vault_config != *vault_config_info.key {
        return Err(VaultError::InvalidSeeds.into());
    }

    let (expected_vault_authority, vault_authority_bump) =
        derive_vault_authority(vault_config_info.key, program_id);
    if expected_vault_authority != *vault_authority_info.key {
        return Err(VaultError::InvalidSeeds.into());
    }

    if vault_config_info.lamports() > 0 {
        return Err(VaultError::AlreadyInitialized.into());
    }

    create_pda_account(
        admin_info,
        vault_config_info,
        system_program_info,
        program_id,
        VaultConfig::LEN,
        &[
            VAULT_SEED,
            admin_info.key.as_ref(),
            &seed.to_le_bytes(),
            &[vault_config_bump],
        ],
    )?;

    let vault_token = load_token_account(vault_info)?;
    if vault_token.owner != *vault_authority_info.key || vault_token.mint != *mint_info.key {
        return Err(VaultError::InvalidTokenAccount.into());
    }

    let vault_config = VaultConfig {
        is_initialized: true,
        seed,
        admin: *admin_info.key,
        mint: *mint_info.key,
        vault_authority_bump,
        paused: false,
        total_deposited: 0,
        total_withdrawn: 0,
    };

    store_vault_config(vault_config_info, &vault_config)
}

fn deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u64,
) -> ProgramResult {
    msg!("deposit");

    if amount == 0 {
        return Err(VaultError::AmountMustBePositive.into());
    }

    let mut account_iter = accounts.iter();
    let user_info = next_signer(&mut account_iter)?;
    let vault_config_info = next_account_info(&mut account_iter)?;
    let vault_authority_info = next_account_info(&mut account_iter)?;
    let mint_info = next_account_info(&mut account_iter)?;
    let vault_info = next_account_info(&mut account_iter)?;
    let user_token_info = next_account_info(&mut account_iter)?;
    let receipt_info = next_account_info(&mut account_iter)?;
    let token_program_info = next_account_info(&mut account_iter)?;
    let associated_token_program_info = next_account_info(&mut account_iter)?;
    let system_program_info = next_account_info(&mut account_iter)?;

    validate_program_account(
        token_program_info,
        &spl_token::id(),
        VaultError::InvalidTokenProgram,
    )?;
    validate_program_account(
        associated_token_program_info,
        &spl_associated_token_account::id(),
        VaultError::InvalidAssociatedTokenProgram,
    )?;
    validate_program_account(
        system_program_info,
        &system_program::id(),
        VaultError::InvalidSystemProgram,
    )?;

    let mut vault_config = load_vault_config(vault_config_info)?;
    if vault_config_info.owner != program_id {
        return Err(VaultError::InvalidOwner.into());
    }
    if vault_config.paused {
        return Err(VaultError::VaultPaused.into());
    }

    let (expected_vault_config, _) =
        derive_vault_config(&vault_config.admin, vault_config.seed, program_id);
    if expected_vault_config != *vault_config_info.key {
        return Err(VaultError::InvalidSeeds.into());
    }

    let (expected_vault_authority, _) = derive_vault_authority(vault_config_info.key, program_id);
    if expected_vault_authority != *vault_authority_info.key {
        return Err(VaultError::InvalidSeeds.into());
    }

    if vault_config.mint != *mint_info.key {
        return Err(VaultError::InvalidMint.into());
    }

    let mint = load_mint(mint_info)?;
    let vault_token = load_token_account(vault_info)?;
    if vault_token.owner != *vault_authority_info.key || vault_token.mint != *mint_info.key {
        return Err(VaultError::InvalidTokenAccount.into());
    }
    let expected_vault = expected_vault_token_address(vault_authority_info.key, mint_info.key);

    let user_token = load_token_account(user_token_info)?;
    if user_token.owner != *user_info.key || user_token.mint != *mint_info.key {
        return Err(VaultError::InvalidTokenAccount.into());
    }

    let (expected_receipt, receipt_bump) =
        derive_receipt(vault_config_info.key, user_info.key, program_id);
    if expected_receipt != *receipt_info.key {
        return Err(VaultError::InvalidReceipt.into());
    }

    if receipt_info.lamports() == 0 {
        create_pda_account(
            user_info,
            receipt_info,
            system_program_info,
            program_id,
            Receipt::LEN,
            &[
                RECEIPT_SEED,
                vault_config_info.key.as_ref(),
                user_info.key.as_ref(),
                &[receipt_bump],
            ],
        )?;
    }

    if receipt_info.owner != program_id {
        return Err(VaultError::InvalidOwner.into());
    }

    let mut receipt = load_receipt(receipt_info)?;
    if !receipt.is_initialized {
        receipt.is_initialized = true;
        receipt.vault_config = *vault_config_info.key;
        receipt.owner = *user_info.key;
        receipt.balance = 0;
    } else {
        if receipt.vault_config != *vault_config_info.key {
            return Err(VaultError::InvalidReceipt.into());
        }
        if receipt.owner != *user_info.key {
            return Err(VaultError::InvalidReceiptOwner.into());
        }
    }

    let instruction = spl_token::instruction::transfer_checked(
        token_program_info.key,
        user_token_info.key,
        mint_info.key,
        vault_info.key,
        user_info.key,
        &[],
        amount,
        mint.decimals,
    )?;

    invoke(
        &instruction,
        &[
            user_token_info.clone(),
            mint_info.clone(),
            vault_info.clone(),
            user_info.clone(),
            token_program_info.clone(),
        ],
    )?;

    receipt.balance = receipt
        .balance
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;
    vault_config.total_deposited = vault_config
        .total_deposited
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;

    store_receipt(receipt_info, &receipt)?;
    store_vault_config(vault_config_info, &vault_config)
}

fn withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u64,
) -> ProgramResult {
    msg!("withdraw");

    if amount == 0 {
        return Err(VaultError::AmountMustBePositive.into());
    }

    let mut account_iter = accounts.iter();
    let user_info = next_signer(&mut account_iter)?;
    let vault_config_info = next_account_info(&mut account_iter)?;
    let vault_authority_info = next_account_info(&mut account_iter)?;
    let mint_info = next_account_info(&mut account_iter)?;
    let vault_info = next_account_info(&mut account_iter)?;
    let user_destination_token_info = next_account_info(&mut account_iter)?;
    let receipt_info = next_account_info(&mut account_iter)?;
    let token_program_info = next_account_info(&mut account_iter)?;

    validate_program_account(
        token_program_info,
        &spl_token::id(),
        VaultError::InvalidTokenProgram,
    )?;

    let mut vault_config = load_vault_config(vault_config_info)?;
    if vault_config_info.owner != program_id {
        return Err(VaultError::InvalidOwner.into());
    }
    if vault_config.paused {
        return Err(VaultError::VaultPaused.into());
    }

    let (expected_vault_config, _) =
        derive_vault_config(&vault_config.admin, vault_config.seed, program_id);
    if expected_vault_config != *vault_config_info.key {
        return Err(VaultError::InvalidSeeds.into());
    }

    let (expected_vault_authority, _) = derive_vault_authority(vault_config_info.key, program_id);
    if expected_vault_authority != *vault_authority_info.key {
        return Err(VaultError::InvalidSeeds.into());
    }

    if vault_config.mint != *mint_info.key {
        return Err(VaultError::InvalidMint.into());
    }

    let mint = load_mint(mint_info)?;
    let vault_token = load_token_account(vault_info)?;
    if vault_token.owner != *vault_authority_info.key || vault_token.mint != *mint_info.key {
        return Err(VaultError::InvalidTokenAccount.into());
    }

    let expected_receipt = derive_receipt(vault_config_info.key, user_info.key, program_id).0;
    if expected_receipt != *receipt_info.key {
        return Err(VaultError::InvalidReceipt.into());
    }

    if receipt_info.owner != program_id {
        return Err(VaultError::InvalidOwner.into());
    }

    let mut receipt = load_receipt(receipt_info)?;
    if !receipt.is_initialized {
        return Err(VaultError::InvalidReceipt.into());
    }
    if receipt.vault_config != *vault_config_info.key {
        return Err(VaultError::InvalidReceipt.into());
    }
    if receipt.owner != *user_info.key {
        return Err(VaultError::InvalidReceiptOwner.into());
    }
    if receipt.balance < amount {
        return Err(VaultError::InsufficientBalance.into());
    }

    let destination = load_token_account(user_destination_token_info)?;
    if destination.owner != *user_info.key || destination.mint != *mint_info.key {
        return Err(VaultError::InvalidTokenAccount.into());
    }

    let signer_seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        vault_config_info.key.as_ref(),
        &[vault_config.vault_authority_bump],
    ];

    let instruction = spl_token::instruction::transfer_checked(
        token_program_info.key,
        vault_info.key,
        mint_info.key,
        user_destination_token_info.key,
        vault_authority_info.key,
        &[],
        amount,
        mint.decimals,
    )?;

    invoke_signed(
        &instruction,
        &[
            vault_info.clone(),
            mint_info.clone(),
            user_destination_token_info.clone(),
            vault_authority_info.clone(),
            token_program_info.clone(),
        ],
        &[signer_seeds],
    )?;

    receipt.balance = receipt
        .balance
        .checked_sub(amount)
        .ok_or(VaultError::Overflow)?;
    vault_config.total_withdrawn = vault_config
        .total_withdrawn
        .checked_add(amount)
        .ok_or(VaultError::Overflow)?;

    store_receipt(receipt_info, &receipt)?;
    store_vault_config(vault_config_info, &vault_config)
}

fn set_paused(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    paused: bool,
) -> ProgramResult {
    msg!("set_paused");

    let mut account_iter = accounts.iter();
    let admin_info = next_signer(&mut account_iter)?;
    let vault_config_info = next_account_info(&mut account_iter)?;

    if vault_config_info.owner != program_id {
        return Err(VaultError::InvalidOwner.into());
    }

    let mut vault_config = load_vault_config(vault_config_info)?;
    let (expected_vault_config, _) =
        derive_vault_config(admin_info.key, vault_config.seed, program_id);
    if expected_vault_config != *vault_config_info.key {
        return Err(VaultError::InvalidSeeds.into());
    }
    if vault_config.admin != *admin_info.key {
        return Err(VaultError::UnauthorizedAdmin.into());
    }

    vault_config.paused = paused;
    store_vault_config(vault_config_info, &vault_config)
}

pub fn derive_vault_config(admin: &Pubkey, seed: u64, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, admin.as_ref(), &seed.to_le_bytes()], program_id)
}

pub fn derive_vault_authority(vault_config: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED, vault_config.as_ref()], program_id)
}

pub fn derive_receipt(vault_config: &Pubkey, owner: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[RECEIPT_SEED, vault_config.as_ref(), owner.as_ref()],
        program_id,
    )
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

pub fn create_vault_token_account<'a>(
    admin_info: &AccountInfo<'a>,
    vault_info: &AccountInfo<'a>,
    vault_authority_info: &AccountInfo<'a>,
    mint_info: &AccountInfo<'a>,
    token_program_info: &AccountInfo<'a>,
    associated_token_program_info: &AccountInfo<'a>,
    system_program_info: &AccountInfo<'a>,
) -> ProgramResult {
    let instruction = create_associated_token_account(
        admin_info.key,
        vault_authority_info.key,
        mint_info.key,
        token_program_info.key,
    );

    invoke(
        &instruction,
        &[
            admin_info.clone(),
            vault_info.clone(),
            vault_authority_info.clone(),
            mint_info.clone(),
            system_program_info.clone(),
            token_program_info.clone(),
            associated_token_program_info.clone(),
        ],
    )
}

pub fn expected_vault_token_address(vault_authority: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(vault_authority, mint, &spl_token::id())
}

pub fn load_vault_config(vault_config_info: &AccountInfo) -> Result<VaultConfig, ProgramError> {
    let data = vault_config_info.try_borrow_data()?;
    let vault_config =
        VaultConfig::try_from_slice(&data).map_err(|_| ProgramError::InvalidAccountData)?;
    if !vault_config.is_initialized {
        return Err(VaultError::NotInitialized.into());
    }
    Ok(vault_config)
}

pub fn store_vault_config(
    vault_config_info: &AccountInfo,
    vault_config: &VaultConfig,
) -> ProgramResult {
    vault_config
        .serialize(&mut &mut vault_config_info.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)
}

pub fn load_receipt(receipt_info: &AccountInfo) -> Result<Receipt, ProgramError> {
    let data = receipt_info.try_borrow_data()?;
    Receipt::try_from_slice(&data).map_err(|_| ProgramError::InvalidAccountData)
}

pub fn store_receipt(receipt_info: &AccountInfo, receipt: &Receipt) -> ProgramResult {
    receipt
        .serialize(&mut &mut receipt_info.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)
}

pub fn load_token_account(token_account_info: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if token_account_info.owner != &spl_token::id() {
        return Err(VaultError::InvalidTokenAccount.into());
    }
    TokenAccount::unpack(&token_account_info.try_borrow_data()?)
}

pub fn load_mint(mint_info: &AccountInfo) -> Result<Mint, ProgramError> {
    if mint_info.owner != &spl_token::id() {
        return Err(VaultError::InvalidMint.into());
    }
    Mint::unpack(&mint_info.try_borrow_data()?).map_err(|_| VaultError::InvalidMint.into())
}

pub fn validate_program_account(
    account_info: &AccountInfo,
    expected: &Pubkey,
    error: VaultError,
) -> ProgramResult {
    if account_info.key != expected {
        return Err(error.into());
    }
    Ok(())
}

pub fn next_signer<'a, 'b>(
    account_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
) -> Result<&'a AccountInfo<'b>, ProgramError> {
    let signer = next_account_info(account_iter)?;
    if !signer.is_signer {
        return Err(VaultError::MissingSignature.into());
    }
    Ok(signer)
}
