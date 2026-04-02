use std::error::Error;

use borsh::{to_vec, BorshDeserialize};
use counter_authority_native::{process_instruction, CounterAccount, CounterInstruction, ID};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    rent::Rent,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};

pub type TestResult<T> = Result<T, Box<dyn Error>>;

pub struct TestContext {
    pub context: ProgramTestContext,
    pub counter: Keypair,
    pub unauthorized: Keypair,
    pub next_authority: Keypair,
}

pub async fn setup() -> TestResult<TestContext> {
    let program_test = ProgramTest::new(
        "counter_authority_native",
        ID,
        processor!(process_instruction),
    );
    let mut context = program_test.start_with_context().await;
    let counter = Keypair::new();
    let unauthorized = Keypair::new();
    let next_authority = Keypair::new();

    fund_keypair(&mut context, unauthorized.pubkey(), 1_000_000_000).await?;
    fund_keypair(&mut context, next_authority.pubkey(), 1_000_000_000).await?;
    create_counter_account(&mut context, &counter).await?;

    Ok(TestContext {
        context,
        counter,
        unauthorized,
        next_authority,
    })
}

pub async fn initialize_counter(
    context: &mut ProgramTestContext,
    counter: Pubkey,
    authority: Pubkey,
    signer: Option<&Keypair>,
) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(counter, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data: to_vec(&CounterInstruction::Initialize)?,
    };
    send_transaction(context, vec![instruction], signer.into_iter().collect()).await
}

pub async fn increment_counter(
    context: &mut ProgramTestContext,
    counter: Pubkey,
    authority: Pubkey,
    signer: Option<&Keypair>,
) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(counter, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data: to_vec(&CounterInstruction::Increment)?,
    };
    send_transaction(context, vec![instruction], signer.into_iter().collect()).await
}

pub async fn set_authority(
    context: &mut ProgramTestContext,
    counter: Pubkey,
    authority: Pubkey,
    signer: Option<&Keypair>,
    new_authority: Pubkey,
) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(counter, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data: to_vec(&CounterInstruction::SetAuthority { new_authority })?,
    };
    send_transaction(context, vec![instruction], signer.into_iter().collect()).await
}

pub async fn fetch_counter(
    context: &mut ProgramTestContext,
    counter: Pubkey,
) -> TestResult<CounterAccount> {
    let account = context
        .banks_client
        .get_account(counter)
        .await?
        .expect("counter account exists");
    Ok(CounterAccount::try_from_slice(&account.data)?)
}

async fn create_counter_account(
    context: &mut ProgramTestContext,
    counter: &Keypair,
) -> TestResult<()> {
    let rent_lamports = Rent::default().minimum_balance(CounterAccount::LEN);
    let instruction = system_instruction::create_account(
        &context.payer.pubkey(),
        &counter.pubkey(),
        rent_lamports,
        CounterAccount::LEN as u64,
        &ID,
    );
    send_transaction(context, vec![instruction], vec![counter]).await
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
