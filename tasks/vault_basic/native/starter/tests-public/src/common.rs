use std::error::Error;

use borsh::{to_vec, BorshDeserialize};
use solana_program::program_pack::Pack;
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    rent::Rent,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};
use spl_token::state::Account as TokenAccount;
use vault_basic_native::{
    derive_receipt, derive_vault_authority, derive_vault_config, process_instruction, Receipt,
    VaultConfig, VaultInstruction, ID,
};

pub type TestResult<T> = Result<T, Box<dyn Error>>;

pub const DEFAULT_SEED: u64 = 11;
pub const INITIAL_USER_BALANCE: u64 = 60;
pub const INITIAL_OTHER_USER_BALANCE: u64 = 45;
pub const DEPOSIT_AMOUNT: u64 = 20;
pub const WITHDRAW_AMOUNT: u64 = 8;

pub struct TestContext {
    pub context: ProgramTestContext,
    pub admin: Pubkey,
    pub user: Keypair,
    pub other_user: Keypair,
    pub attacker: Keypair,
    pub seed: u64,
    pub mint: Keypair,
    pub alternate_mint: Keypair,
    pub user_token: Pubkey,
    pub other_user_token: Pubkey,
    pub attacker_token: Pubkey,
    pub user_alternate_token: Pubkey,
    pub vault_config: Pubkey,
    pub vault_authority: Pubkey,
    pub vault: Pubkey,
    pub user_receipt: Pubkey,
    pub other_user_receipt: Pubkey,
}

pub async fn setup() -> TestResult<TestContext> {
    let mut program_test = ProgramTest::new("vault_basic_native", ID, processor!(process_instruction));
    program_test.add_program(
        "spl_token",
        spl_token::id(),
        processor!(spl_token::processor::Processor::process),
    );
    program_test.add_program(
        "spl_associated_token_account",
        spl_associated_token_account::id(),
        processor!(spl_associated_token_account::processor::process_instruction),
    );

    let mut context = program_test.start_with_context().await;
    let admin = context.payer.pubkey();
    let user = Keypair::new();
    let other_user = Keypair::new();
    let attacker = Keypair::new();

    fund_keypair(&mut context, user.pubkey(), 2_000_000_000).await?;
    fund_keypair(&mut context, other_user.pubkey(), 2_000_000_000).await?;
    fund_keypair(&mut context, attacker.pubkey(), 2_000_000_000).await?;

    let mint = create_mint(&mut context, admin, 0).await?;
    let alternate_mint = create_mint(&mut context, admin, 0).await?;

    let user_token = create_token_account(&mut context, user.pubkey(), mint.pubkey()).await?;
    let other_user_token =
        create_token_account(&mut context, other_user.pubkey(), mint.pubkey()).await?;
    let attacker_token = create_token_account(&mut context, attacker.pubkey(), mint.pubkey()).await?;
    let user_alternate_token =
        create_token_account(&mut context, user.pubkey(), alternate_mint.pubkey()).await?;

    mint_tokens(
        &mut context,
        mint.pubkey(),
        user_token,
        INITIAL_USER_BALANCE,
    )
    .await?;
    mint_tokens(
        &mut context,
        mint.pubkey(),
        other_user_token,
        INITIAL_OTHER_USER_BALANCE,
    )
    .await?;
    mint_tokens(
        &mut context,
        alternate_mint.pubkey(),
        user_alternate_token,
        INITIAL_USER_BALANCE,
    )
    .await?;

    let seed = DEFAULT_SEED;
    let (vault_config, _) = derive_vault_config(&admin, seed, &ID);
    let (vault_authority, _) = derive_vault_authority(&vault_config, &ID);
    let vault = create_token_account(&mut context, vault_authority, mint.pubkey()).await?;
    let (user_receipt, _) = derive_receipt(&vault_config, &user.pubkey(), &ID);
    let (other_user_receipt, _) = derive_receipt(&vault_config, &other_user.pubkey(), &ID);

    Ok(TestContext {
        context,
        admin,
        user,
        other_user,
        attacker,
        seed,
        mint,
        alternate_mint,
        user_token,
        other_user_token,
        attacker_token,
        user_alternate_token,
        vault_config,
        vault_authority,
        vault,
        user_receipt,
        other_user_receipt,
    })
}

pub async fn initialize_vault(context: &mut TestContext) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(context.admin, true),
            AccountMeta::new_readonly(context.mint.pubkey(), false),
            AccountMeta::new(context.vault_config, false),
            AccountMeta::new_readonly(context.vault_authority, false),
            AccountMeta::new(context.vault, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(spl_associated_token_account::id(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: to_vec(&VaultInstruction::Initialize { seed: context.seed })?,
    };
    send_transaction(&mut context.context, vec![instruction], Vec::new()).await
}

pub async fn deposit_default(context: &mut TestContext) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(context.user.pubkey(), true),
            AccountMeta::new(context.vault_config, false),
            AccountMeta::new_readonly(context.vault_authority, false),
            AccountMeta::new_readonly(context.mint.pubkey(), false),
            AccountMeta::new(context.vault, false),
            AccountMeta::new(context.user_token, false),
            AccountMeta::new(context.user_receipt, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(spl_associated_token_account::id(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: to_vec(&VaultInstruction::Deposit {
            amount: DEPOSIT_AMOUNT,
        })?,
    };
    send_transaction(&mut context.context, vec![instruction], vec![&context.user]).await
}

pub async fn deposit(
    context: &mut TestContext,
    user: Pubkey,
    signer: &Keypair,
    mint: Pubkey,
    user_token: Pubkey,
    receipt: Pubkey,
    amount: u64,
) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(user, true),
            AccountMeta::new(context.vault_config, false),
            AccountMeta::new_readonly(context.vault_authority, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(context.vault, false),
            AccountMeta::new(user_token, false),
            AccountMeta::new(receipt, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(spl_associated_token_account::id(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: to_vec(&VaultInstruction::Deposit { amount })?,
    };
    send_transaction(&mut context.context, vec![instruction], vec![signer]).await
}

pub async fn withdraw_default(context: &mut TestContext) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new_readonly(context.user.pubkey(), true),
            AccountMeta::new(context.vault_config, false),
            AccountMeta::new_readonly(context.vault_authority, false),
            AccountMeta::new_readonly(context.mint.pubkey(), false),
            AccountMeta::new(context.vault, false),
            AccountMeta::new(context.user_token, false),
            AccountMeta::new(context.user_receipt, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: to_vec(&VaultInstruction::Withdraw {
            amount: WITHDRAW_AMOUNT,
        })?,
    };
    send_transaction(&mut context.context, vec![instruction], vec![&context.user]).await
}

pub async fn withdraw(
    context: &mut TestContext,
    user: Pubkey,
    signer: &Keypair,
    mint: Pubkey,
    user_destination_token: Pubkey,
    receipt: Pubkey,
    amount: u64,
) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new_readonly(user, true),
            AccountMeta::new(context.vault_config, false),
            AccountMeta::new_readonly(context.vault_authority, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(context.vault, false),
            AccountMeta::new(user_destination_token, false),
            AccountMeta::new(receipt, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: to_vec(&VaultInstruction::Withdraw { amount })?,
    };
    send_transaction(&mut context.context, vec![instruction], vec![signer]).await
}

pub async fn set_paused(context: &mut TestContext, paused: bool) -> TestResult<()> {
    set_paused_as(context, context.admin, None, paused).await
}

pub async fn set_paused_as(
    context: &mut TestContext,
    admin: Pubkey,
    signer: Option<&Keypair>,
    paused: bool,
) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new_readonly(admin, true),
            AccountMeta::new(context.vault_config, false),
        ],
        data: to_vec(&VaultInstruction::SetPaused { paused })?,
    };
    send_transaction(
        &mut context.context,
        vec![instruction],
        signer.into_iter().collect(),
    )
    .await
}

pub async fn fetch_vault_config(context: &mut TestContext) -> TestResult<VaultConfig> {
    let account = context
        .context
        .banks_client
        .get_account(context.vault_config)
        .await?
        .expect("vault config exists");
    Ok(VaultConfig::try_from_slice(&account.data)?)
}

pub async fn fetch_receipt(context: &mut TestContext, receipt: Pubkey) -> TestResult<Receipt> {
    let account = context
        .context
        .banks_client
        .get_account(receipt)
        .await?
        .expect("receipt exists");
    Ok(Receipt::try_from_slice(&account.data)?)
}

pub async fn token_balance(context: &mut TestContext, account: Pubkey) -> TestResult<u64> {
    let account = context
        .context
        .banks_client
        .get_account(account)
        .await?
        .expect("token account exists");
    Ok(TokenAccount::unpack(&account.data)?.amount)
}

pub fn clone_keypair(keypair: &Keypair) -> Keypair {
    Keypair::from_bytes(&keypair.to_bytes()).expect("keypair copy")
}

async fn create_mint(
    context: &mut ProgramTestContext,
    authority: Pubkey,
    decimals: u8,
) -> TestResult<Keypair> {
    let mint = Keypair::new();
    let rent = Rent::default().minimum_balance(spl_token::state::Mint::LEN);

    let create = system_instruction::create_account(
        &context.payer.pubkey(),
        &mint.pubkey(),
        rent,
        spl_token::state::Mint::LEN as u64,
        &spl_token::id(),
    );
    let initialize =
        spl_token::instruction::initialize_mint(&spl_token::id(), &mint.pubkey(), &authority, None, decimals)?;

    send_transaction(context, vec![create, initialize], vec![&mint]).await?;
    Ok(mint)
}

async fn create_token_account(
    context: &mut ProgramTestContext,
    owner: Pubkey,
    mint: Pubkey,
) -> TestResult<Pubkey> {
    let account = Keypair::new();
    let rent = Rent::default().minimum_balance(TokenAccount::LEN);
    let create = system_instruction::create_account(
        &context.payer.pubkey(),
        &account.pubkey(),
        rent,
        TokenAccount::LEN as u64,
        &spl_token::id(),
    );
    let initialize = spl_token::instruction::initialize_account3(
        &spl_token::id(),
        &account.pubkey(),
        &mint,
        &owner,
    )?;
    send_transaction(context, vec![create, initialize], vec![&account]).await?;
    Ok(account.pubkey())
}

async fn mint_tokens(
    context: &mut ProgramTestContext,
    mint: Pubkey,
    destination: Pubkey,
    amount: u64,
) -> TestResult<()> {
    let instruction = spl_token::instruction::mint_to(
        &spl_token::id(),
        &mint,
        &destination,
        &context.payer.pubkey(),
        &[],
        amount,
    )?;
    send_transaction(context, vec![instruction], Vec::new()).await
}

async fn fund_keypair(
    context: &mut ProgramTestContext,
    recipient: Pubkey,
    lamports: u64,
) -> TestResult<()> {
    let instruction = system_instruction::transfer(&context.payer.pubkey(), &recipient, lamports);
    send_transaction(context, vec![instruction], Vec::new()).await
}

async fn send_transaction(
    context: &mut ProgramTestContext,
    instructions: Vec<Instruction>,
    extra_signers: Vec<&Keypair>,
) -> TestResult<()> {
    let mut signers: Vec<&Keypair> = vec![&context.payer];
    signers.extend(extra_signers);

    let transaction = Transaction::new_signed_with_payer(
        &instructions,
        Some(&context.payer.pubkey()),
        &signers,
        context.last_blockhash,
    );
    context.banks_client.process_transaction(transaction).await?;
    context.last_blockhash = context.get_new_latest_blockhash().await?;
    Ok(())
}
