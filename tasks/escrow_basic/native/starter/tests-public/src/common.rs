use std::error::Error;

use borsh::{to_vec, BorshDeserialize};
use escrow_basic_native::{
    derive_escrow, derive_vault_authority, process_instruction, EscrowInstruction, EscrowState, ID,
};
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

pub type TestResult<T> = Result<T, Box<dyn Error>>;

pub const DEFAULT_SEED: u64 = 7;
pub const OFFERED_AMOUNT: u64 = 10;
pub const DESIRED_AMOUNT: u64 = 7;
pub const MAKER_OFFERED_BALANCE: u64 = 25;
pub const TAKER_DESIRED_BALANCE: u64 = 40;
pub const TAKER_ALTERNATE_BALANCE: u64 = 40;

pub struct TestContext {
    pub context: ProgramTestContext,
    pub maker: Pubkey,
    pub taker: Keypair,
    pub attacker: Keypair,
    pub seed: u64,
    pub offered_mint: Keypair,
    pub desired_mint: Keypair,
    pub alternate_mint: Keypair,
    pub maker_offered_token: Pubkey,
    pub maker_desired_token: Pubkey,
    pub maker_alternate_token: Pubkey,
    pub taker_offered_token: Pubkey,
    pub taker_desired_token: Pubkey,
    pub taker_alternate_token: Pubkey,
    pub attacker_offered_token: Pubkey,
    pub attacker_desired_token: Pubkey,
    pub escrow: Pubkey,
    pub vault_authority: Pubkey,
    pub vault: Pubkey,
}

pub async fn setup() -> TestResult<TestContext> {
    let mut program_test =
        ProgramTest::new("escrow_basic_native", ID, processor!(process_instruction));
    program_test.add_program(
        "spl_token",
        spl_token::id(),
        processor!(spl_token::processor::Processor::process),
    );

    let mut context = program_test.start_with_context().await;
    let maker = context.payer.pubkey();
    let taker = Keypair::new();
    let attacker = Keypair::new();

    fund_keypair(&mut context, taker.pubkey(), 2_000_000_000).await?;
    fund_keypair(&mut context, attacker.pubkey(), 2_000_000_000).await?;

    let offered_mint = create_mint(&mut context, maker, 0).await?;
    let desired_mint = create_mint(&mut context, maker, 0).await?;
    let alternate_mint = create_mint(&mut context, maker, 0).await?;

    let maker_offered_token = create_token_account(&mut context, maker, offered_mint.pubkey()).await?;
    let maker_desired_token = create_token_account(&mut context, maker, desired_mint.pubkey()).await?;
    let maker_alternate_token =
        create_token_account(&mut context, maker, alternate_mint.pubkey()).await?;
    let taker_offered_token =
        create_token_account(&mut context, taker.pubkey(), offered_mint.pubkey()).await?;
    let taker_desired_token =
        create_token_account(&mut context, taker.pubkey(), desired_mint.pubkey()).await?;
    let taker_alternate_token =
        create_token_account(&mut context, taker.pubkey(), alternate_mint.pubkey()).await?;
    let attacker_offered_token =
        create_token_account(&mut context, attacker.pubkey(), offered_mint.pubkey()).await?;
    let attacker_desired_token =
        create_token_account(&mut context, attacker.pubkey(), desired_mint.pubkey()).await?;

    mint_tokens(
        &mut context,
        offered_mint.pubkey(),
        maker_offered_token,
        MAKER_OFFERED_BALANCE,
    )
    .await?;
    mint_tokens(
        &mut context,
        desired_mint.pubkey(),
        taker_desired_token,
        TAKER_DESIRED_BALANCE,
    )
    .await?;
    mint_tokens(
        &mut context,
        alternate_mint.pubkey(),
        taker_alternate_token,
        TAKER_ALTERNATE_BALANCE,
    )
    .await?;

    let seed = DEFAULT_SEED;
    let (escrow, _) = derive_escrow(&maker, seed, &ID);
    let (vault_authority, _) = derive_vault_authority(&escrow, &ID);
    let vault = create_token_account(&mut context, vault_authority, offered_mint.pubkey()).await?;

    Ok(TestContext {
        context,
        maker,
        taker,
        attacker,
        seed,
        offered_mint,
        desired_mint,
        alternate_mint,
        maker_offered_token,
        maker_desired_token,
        maker_alternate_token,
        taker_offered_token,
        taker_desired_token,
        taker_alternate_token,
        attacker_offered_token,
        attacker_desired_token,
        escrow,
        vault_authority,
        vault,
    })
}

pub async fn initialize_escrow(context: &mut TestContext) -> TestResult<()> {
    initialize_with_amounts(context, OFFERED_AMOUNT, DESIRED_AMOUNT).await
}

pub async fn initialize_with_amounts(
    context: &mut TestContext,
    offered_amount: u64,
    desired_amount: u64,
) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(context.maker, true),
            AccountMeta::new_readonly(context.offered_mint.pubkey(), false),
            AccountMeta::new_readonly(context.desired_mint.pubkey(), false),
            AccountMeta::new(context.escrow, false),
            AccountMeta::new_readonly(context.vault_authority, false),
            AccountMeta::new(context.maker_offered_token, false),
            AccountMeta::new(context.vault, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data: to_vec(&EscrowInstruction::Initialize {
            seed: context.seed,
            offered_amount,
            desired_amount,
        })?,
    };
    send_transaction(&mut context.context, vec![instruction], Vec::new()).await
}

pub async fn exchange_default(context: &mut TestContext) -> TestResult<()> {
    let taker = clone_keypair(&context.taker);
    exchange(
        context,
        context.maker,
        context.maker_desired_token,
        taker.pubkey(),
        Some(&taker),
        context.taker_desired_token,
        context.taker_offered_token,
        context.desired_mint.pubkey(),
    )
    .await
}

pub async fn exchange(
    context: &mut TestContext,
    maker: Pubkey,
    maker_receive_token: Pubkey,
    taker: Pubkey,
    signer: Option<&Keypair>,
    taker_deposit_token: Pubkey,
    taker_receive_token: Pubkey,
    desired_mint: Pubkey,
) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new_readonly(taker, true),
            AccountMeta::new(maker, false),
            AccountMeta::new(context.escrow, false),
            AccountMeta::new_readonly(context.vault_authority, false),
            AccountMeta::new_readonly(context.offered_mint.pubkey(), false),
            AccountMeta::new_readonly(desired_mint, false),
            AccountMeta::new(context.vault, false),
            AccountMeta::new(maker_receive_token, false),
            AccountMeta::new(taker_deposit_token, false),
            AccountMeta::new(taker_receive_token, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: to_vec(&EscrowInstruction::Exchange)?,
    };
    send_transaction(
        &mut context.context,
        vec![instruction],
        signer.into_iter().collect(),
    )
    .await
}

pub async fn cancel_default(context: &mut TestContext) -> TestResult<()> {
    cancel(context, context.maker, None, context.maker_offered_token).await
}

pub async fn cancel(
    context: &mut TestContext,
    maker: Pubkey,
    signer: Option<&Keypair>,
    maker_receive_token: Pubkey,
) -> TestResult<()> {
    let instruction = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new(maker, true),
            AccountMeta::new(context.escrow, false),
            AccountMeta::new_readonly(context.vault_authority, false),
            AccountMeta::new_readonly(context.offered_mint.pubkey(), false),
            AccountMeta::new(context.vault, false),
            AccountMeta::new(maker_receive_token, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: to_vec(&EscrowInstruction::Cancel)?,
    };
    send_transaction(
        &mut context.context,
        vec![instruction],
        signer.into_iter().collect(),
    )
    .await
}

pub async fn fetch_escrow(context: &mut TestContext) -> TestResult<EscrowState> {
    let account = context
        .context
        .banks_client
        .get_account(context.escrow)
        .await?
        .expect("escrow exists");
    Ok(EscrowState::try_from_slice(&account.data)?)
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

pub async fn account_is_closed(context: &mut TestContext, address: Pubkey) -> TestResult<bool> {
    Ok(match context.context.banks_client.get_account(address).await? {
        None => true,
        Some(account) => account.lamports == 0 || account.data.is_empty(),
    })
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
    let initialize = spl_token::instruction::initialize_mint(
        &spl_token::id(),
        &mint.pubkey(),
        &authority,
        None,
        decimals,
    )?;

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
