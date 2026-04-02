use std::{
    env,
    error::Error,
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

use anchor_client::{
    solana_sdk::{
        commitment_config::CommitmentConfig,
        instruction::Instruction,
        program_pack::Pack,
        pubkey::Pubkey,
        signature::{read_keypair_file, Keypair, Signature, Signer},
        system_instruction, system_program,
        transaction::Transaction,
    },
    Client, Cluster, Program,
};
use escrow_basic::{accounts, instruction, Escrow, ID};

pub type BenchmarkProgram = Program<Rc<Keypair>>;
pub type TestResult<T> = Result<T, Box<dyn Error>>;

pub const DEFAULT_SEED: u64 = 7;
pub const OFFERED_AMOUNT: u64 = 10;
pub const DESIRED_AMOUNT: u64 = 7;
pub const MAKER_OFFERED_BALANCE: u64 = 25;
pub const TAKER_DESIRED_BALANCE: u64 = 40;
pub const TAKER_ALTERNATE_BALANCE: u64 = 40;

static NEXT_SEED: AtomicU64 = AtomicU64::new(DEFAULT_SEED);

pub struct TestContext {
    pub program: BenchmarkProgram,
    pub payer: Rc<Keypair>,
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

pub fn setup() -> TestResult<TestContext> {
    let cluster_url = env::var("ANCHOR_PROVIDER_URL")?;
    let wallet_path = resolve_wallet_path(&env::var("ANCHOR_WALLET")?);
    let payer = Rc::new(read_keypair_file(&wallet_path)?);
    let maker = payer.pubkey();
    let websocket_url = websocket_url(&cluster_url);
    let client = Client::new_with_options(
        Cluster::Custom(cluster_url, websocket_url),
        payer.clone(),
        CommitmentConfig::confirmed(),
    );
    let program = client.program(ID)?;

    let taker = Keypair::new();
    let attacker = Keypair::new();
    fund_system_account(&program, payer.as_ref(), taker.pubkey(), 2_000_000_000)?;
    fund_system_account(&program, payer.as_ref(), attacker.pubkey(), 2_000_000_000)?;

    let offered_mint = create_mint(&program, payer.as_ref(), maker, 0)?;
    let desired_mint = create_mint(&program, payer.as_ref(), maker, 0)?;
    let alternate_mint = create_mint(&program, payer.as_ref(), maker, 0)?;

    let maker_offered_token =
        create_associated_token_account(&program, payer.as_ref(), maker, offered_mint.pubkey())?;
    let maker_desired_token =
        create_associated_token_account(&program, payer.as_ref(), maker, desired_mint.pubkey())?;
    let maker_alternate_token =
        create_associated_token_account(&program, payer.as_ref(), maker, alternate_mint.pubkey())?;
    let taker_offered_token = create_associated_token_account(
        &program,
        payer.as_ref(),
        taker.pubkey(),
        offered_mint.pubkey(),
    )?;
    let taker_desired_token = create_associated_token_account(
        &program,
        payer.as_ref(),
        taker.pubkey(),
        desired_mint.pubkey(),
    )?;
    let taker_alternate_token = create_associated_token_account(
        &program,
        payer.as_ref(),
        taker.pubkey(),
        alternate_mint.pubkey(),
    )?;
    let attacker_offered_token = create_associated_token_account(
        &program,
        payer.as_ref(),
        attacker.pubkey(),
        offered_mint.pubkey(),
    )?;
    let attacker_desired_token = create_associated_token_account(
        &program,
        payer.as_ref(),
        attacker.pubkey(),
        desired_mint.pubkey(),
    )?;

    mint_tokens(
        &program,
        payer.as_ref(),
        offered_mint.pubkey(),
        maker_offered_token,
        MAKER_OFFERED_BALANCE,
    )?;
    mint_tokens(
        &program,
        payer.as_ref(),
        desired_mint.pubkey(),
        taker_desired_token,
        TAKER_DESIRED_BALANCE,
    )?;
    mint_tokens(
        &program,
        payer.as_ref(),
        alternate_mint.pubkey(),
        taker_alternate_token,
        TAKER_ALTERNATE_BALANCE,
    )?;

    let seed = NEXT_SEED.fetch_add(1, Ordering::Relaxed);
    let (escrow, vault_authority) = derive_escrow_addresses(maker, seed);
    let vault = spl_associated_token_account::get_associated_token_address(
        &vault_authority,
        &offered_mint.pubkey(),
    );

    Ok(TestContext {
        program,
        payer,
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

pub fn initialize_escrow(context: &TestContext) -> TestResult<Signature> {
    initialize_with_amounts(context, OFFERED_AMOUNT, DESIRED_AMOUNT)
}

pub fn initialize_with_amounts(
    context: &TestContext,
    offered_amount: u64,
    desired_amount: u64,
) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::Initialize {
            maker: context.maker,
            escrow: context.escrow,
            vault_authority: context.vault_authority,
            offered_mint: context.offered_mint.pubkey(),
            desired_mint: context.desired_mint.pubkey(),
            maker_offered_token: context.maker_offered_token,
            vault: context.vault,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        })
        .args(instruction::Initialize {
            seed: context.seed,
            offered_amount,
            desired_amount,
        })
        .send()?)
}

pub fn exchange_default(context: &TestContext) -> TestResult<Signature> {
    exchange(
        context,
        context.maker,
        context.maker_desired_token,
        context.taker.pubkey(),
        Some(&context.taker),
        context.taker_desired_token,
        context.taker_offered_token,
        context.desired_mint.pubkey(),
    )
}

pub fn exchange(
    context: &TestContext,
    maker: Pubkey,
    maker_receive_token: Pubkey,
    taker: Pubkey,
    signer: Option<&Keypair>,
    taker_deposit_token: Pubkey,
    taker_receive_token: Pubkey,
    desired_mint: Pubkey,
) -> TestResult<Signature> {
    let mut request = context
        .program
        .request()
        .accounts(accounts::Exchange {
            taker,
            maker,
            escrow: context.escrow,
            vault_authority: context.vault_authority,
            offered_mint: context.offered_mint.pubkey(),
            desired_mint,
            vault: context.vault,
            maker_receive_token,
            taker_deposit_token,
            taker_receive_token,
            token_program: spl_token::ID,
        })
        .args(instruction::Exchange {});

    if let Some(signer) = signer {
        request = request.signer(signer);
    }

    Ok(request.send()?)
}

pub fn cancel_default(context: &TestContext) -> TestResult<Signature> {
    cancel(context, context.maker, None, context.maker_offered_token)
}

pub fn cancel(
    context: &TestContext,
    maker: Pubkey,
    signer: Option<&Keypair>,
    maker_receive_token: Pubkey,
) -> TestResult<Signature> {
    let mut request = context
        .program
        .request()
        .accounts(accounts::Cancel {
            maker,
            escrow: context.escrow,
            vault_authority: context.vault_authority,
            offered_mint: context.offered_mint.pubkey(),
            vault: context.vault,
            maker_receive_token,
            token_program: spl_token::ID,
        })
        .args(instruction::Cancel {});

    if let Some(signer) = signer {
        request = request.signer(signer);
    }

    Ok(request.send()?)
}

pub fn fetch_escrow(context: &TestContext) -> TestResult<Escrow> {
    Ok(context.program.account(context.escrow)?)
}

pub fn token_balance(context: &TestContext, token_account: Pubkey) -> TestResult<u64> {
    let account = context.program.rpc().get_account(&token_account)?;
    let token_account = spl_token::state::Account::unpack(&account.data)?;
    Ok(token_account.amount)
}

pub fn account_exists(context: &TestContext, address: Pubkey) -> bool {
    context.program.rpc().get_account(&address).is_ok()
}

fn derive_escrow_addresses(maker: Pubkey, seed: u64) -> (Pubkey, Pubkey) {
    let seed_bytes = seed.to_le_bytes();
    let (escrow, _) = Pubkey::find_program_address(&[b"escrow", maker.as_ref(), &seed_bytes], &ID);
    let (vault_authority, _) =
        Pubkey::find_program_address(&[b"vault_authority", escrow.as_ref()], &ID);
    (escrow, vault_authority)
}

fn create_mint(
    program: &BenchmarkProgram,
    payer: &Keypair,
    mint_authority: Pubkey,
    decimals: u8,
) -> TestResult<Keypair> {
    let mint = Keypair::new();
    let rent = program
        .rpc()
        .get_minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN)?;
    let create_account = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        rent,
        spl_token::state::Mint::LEN as u64,
        &spl_token::ID,
    );
    let initialize_mint = spl_token::instruction::initialize_mint(
        &spl_token::ID,
        &mint.pubkey(),
        &mint_authority,
        None,
        decimals,
    )?;
    send_transaction(program, payer, vec![create_account, initialize_mint], &[&mint])?;
    Ok(mint)
}

fn create_associated_token_account(
    program: &BenchmarkProgram,
    payer: &Keypair,
    owner: Pubkey,
    mint: Pubkey,
) -> TestResult<Pubkey> {
    let ata = spl_associated_token_account::get_associated_token_address(&owner, &mint);
    let create_ata = spl_associated_token_account::instruction::create_associated_token_account(
        &payer.pubkey(),
        &owner,
        &mint,
        &spl_token::ID,
    );
    send_transaction(program, payer, vec![create_ata], &[])?;
    Ok(ata)
}

fn mint_tokens(
    program: &BenchmarkProgram,
    payer: &Keypair,
    mint: Pubkey,
    destination: Pubkey,
    amount: u64,
) -> TestResult<Signature> {
    let mint_to = spl_token::instruction::mint_to(
        &spl_token::ID,
        &mint,
        &destination,
        &payer.pubkey(),
        &[],
        amount,
    )?;
    send_transaction(program, payer, vec![mint_to], &[])
}

fn fund_system_account(
    program: &BenchmarkProgram,
    payer: &Keypair,
    recipient: Pubkey,
    lamports: u64,
) -> TestResult<Signature> {
    let transfer = system_instruction::transfer(&payer.pubkey(), &recipient, lamports);
    send_transaction(program, payer, vec![transfer], &[])
}

fn send_transaction(
    program: &BenchmarkProgram,
    payer: &Keypair,
    instructions: Vec<Instruction>,
    additional_signers: &[&Keypair],
) -> TestResult<Signature> {
    let recent_blockhash = program.rpc().get_latest_blockhash()?;
    let mut signers: Vec<&dyn Signer> = vec![payer];
    for signer in additional_signers {
        signers.push(*signer);
    }

    let transaction = Transaction::new_signed_with_payer(
        &instructions,
        Some(&payer.pubkey()),
        &signers,
        recent_blockhash,
    );
    Ok(program.rpc().send_and_confirm_transaction(&transaction)?)
}

fn websocket_url(http_url: &str) -> String {
    if let Some(rest) = http_url.strip_prefix("https://") {
        return format!("wss://{rest}");
    }

    if let Some(rest) = http_url.strip_prefix("http://") {
        return format!("ws://{rest}");
    }

    http_url.to_owned()
}

fn resolve_wallet_path(wallet_path: &str) -> PathBuf {
    let candidate = PathBuf::from(wallet_path);
    if candidate.is_absolute() {
        return candidate;
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root is available")
        .join(candidate)
}
