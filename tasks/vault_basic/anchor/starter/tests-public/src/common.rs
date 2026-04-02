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
        program_pack::Pack,
        pubkey::Pubkey,
        signature::{read_keypair_file, Keypair, Signature, Signer},
        system_instruction, system_program,
        transaction::Transaction,
    },
    Client, Cluster, Program,
};
use vault_basic::{accounts, instruction, Receipt, VaultConfig, ID};

pub type BenchmarkProgram = Program<Rc<Keypair>>;
pub type TestResult<T> = Result<T, Box<dyn Error>>;

pub const DEFAULT_SEED: u64 = 11;
pub const INITIAL_USER_BALANCE: u64 = 60;
pub const INITIAL_OTHER_USER_BALANCE: u64 = 45;
pub const DEPOSIT_AMOUNT: u64 = 20;
pub const WITHDRAW_AMOUNT: u64 = 8;

static NEXT_SEED: AtomicU64 = AtomicU64::new(DEFAULT_SEED);

pub struct TestContext {
    pub program: BenchmarkProgram,
    pub payer: Rc<Keypair>,
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

pub fn setup() -> TestResult<TestContext> {
    let cluster_url = env::var("ANCHOR_PROVIDER_URL")?;
    let wallet_path = resolve_wallet_path(&env::var("ANCHOR_WALLET")?);
    let payer = Rc::new(read_keypair_file(&wallet_path)?);
    let admin = payer.pubkey();
    let websocket_url = websocket_url(&cluster_url);
    let client = Client::new_with_options(
        Cluster::Custom(cluster_url, websocket_url),
        payer.clone(),
        CommitmentConfig::confirmed(),
    );
    let program = client.program(ID)?;

    let user = Keypair::new();
    let other_user = Keypair::new();
    let attacker = Keypair::new();
    fund_system_account(&program, payer.as_ref(), user.pubkey(), 2_000_000_000)?;
    fund_system_account(&program, payer.as_ref(), other_user.pubkey(), 2_000_000_000)?;
    fund_system_account(&program, payer.as_ref(), attacker.pubkey(), 2_000_000_000)?;

    let mint = create_mint(&program, payer.as_ref(), admin, 0)?;
    let alternate_mint = create_mint(&program, payer.as_ref(), admin, 0)?;

    let user_token = create_associated_token_account(&program, payer.as_ref(), user.pubkey(), mint.pubkey())?;
    let other_user_token =
        create_associated_token_account(&program, payer.as_ref(), other_user.pubkey(), mint.pubkey())?;
    let attacker_token =
        create_associated_token_account(&program, payer.as_ref(), attacker.pubkey(), mint.pubkey())?;
    let user_alternate_token =
        create_associated_token_account(&program, payer.as_ref(), user.pubkey(), alternate_mint.pubkey())?;

    mint_tokens(
        &program,
        payer.as_ref(),
        mint.pubkey(),
        user_token,
        INITIAL_USER_BALANCE,
    )?;
    mint_tokens(
        &program,
        payer.as_ref(),
        mint.pubkey(),
        other_user_token,
        INITIAL_OTHER_USER_BALANCE,
    )?;
    mint_tokens(
        &program,
        payer.as_ref(),
        alternate_mint.pubkey(),
        user_alternate_token,
        INITIAL_USER_BALANCE,
    )?;

    let seed = NEXT_SEED.fetch_add(1, Ordering::Relaxed);
    let (vault_config, vault_authority) = derive_vault_addresses(admin, seed);
    let vault =
        spl_associated_token_account::get_associated_token_address(&vault_authority, &mint.pubkey());
    let user_receipt = derive_receipt(vault_config, user.pubkey());
    let other_user_receipt = derive_receipt(vault_config, other_user.pubkey());

    Ok(TestContext {
        program,
        payer,
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

pub fn initialize_vault(context: &TestContext) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::Initialize {
            admin: context.admin,
            mint: context.mint.pubkey(),
            vault_config: context.vault_config,
            vault_authority: context.vault_authority,
            vault: context.vault,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        })
        .args(instruction::Initialize { seed: context.seed })
        .send()?)
}

pub fn deposit_default(context: &TestContext) -> TestResult<Signature> {
    deposit(
        context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.user_token,
        context.user_receipt,
        DEPOSIT_AMOUNT,
    )
}

pub fn deposit(
    context: &TestContext,
    user: Pubkey,
    signer: &Keypair,
    mint: Pubkey,
    user_token: Pubkey,
    receipt: Pubkey,
    amount: u64,
) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::Deposit {
            user,
            vault_config: context.vault_config,
            vault_authority: context.vault_authority,
            mint,
            vault: context.vault,
            user_token,
            receipt,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        })
        .args(instruction::Deposit { amount })
        .signer(signer)
        .send()?)
}

pub fn withdraw_default(context: &TestContext) -> TestResult<Signature> {
    withdraw(
        context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.user_token,
        context.user_receipt,
        WITHDRAW_AMOUNT,
    )
}

pub fn withdraw(
    context: &TestContext,
    user: Pubkey,
    signer: &Keypair,
    mint: Pubkey,
    user_destination_token: Pubkey,
    receipt: Pubkey,
    amount: u64,
) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::Withdraw {
            user,
            vault_config: context.vault_config,
            vault_authority: context.vault_authority,
            mint,
            vault: context.vault,
            user_destination_token,
            receipt,
            token_program: spl_token::ID,
        })
        .args(instruction::Withdraw { amount })
        .signer(signer)
        .send()?)
}

pub fn set_paused(context: &TestContext, paused: bool) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::SetPaused {
            admin: context.admin,
            vault_config: context.vault_config,
        })
        .args(instruction::SetPaused { paused })
        .send()?)
}

pub fn set_paused_as(
    context: &TestContext,
    admin: Pubkey,
    signer: Option<&Keypair>,
    paused: bool,
) -> TestResult<Signature> {
    let mut request = context
        .program
        .request()
        .accounts(accounts::SetPaused {
            admin,
            vault_config: context.vault_config,
        })
        .args(instruction::SetPaused { paused });

    if let Some(signer) = signer {
        request = request.signer(signer);
    }

    Ok(request.send()?)
}

pub fn fetch_vault_config(context: &TestContext) -> TestResult<VaultConfig> {
    Ok(context.program.account(context.vault_config)?)
}

pub fn fetch_receipt(context: &TestContext, receipt: Pubkey) -> TestResult<Receipt> {
    Ok(context.program.account(receipt)?)
}

pub fn token_balance(context: &TestContext, token_account: Pubkey) -> TestResult<u64> {
    let account = context.program.rpc().get_account(&token_account)?;
    let parsed = spl_token::state::Account::unpack(&account.data)?;
    Ok(parsed.amount)
}

pub fn account_exists(context: &TestContext, account: Pubkey) -> bool {
    context.program.rpc().get_account(&account).is_ok()
}

fn derive_vault_addresses(admin: Pubkey, seed: u64) -> (Pubkey, Pubkey) {
    let seed_bytes = seed.to_le_bytes();
    let (vault_config, _) = Pubkey::find_program_address(&[b"vault", admin.as_ref(), &seed_bytes], &ID);
    let (vault_authority, _) =
        Pubkey::find_program_address(&[b"vault_authority", vault_config.as_ref()], &ID);
    (vault_config, vault_authority)
}

fn derive_receipt(vault_config: Pubkey, user: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"receipt", vault_config.as_ref(), user.as_ref()], &ID).0
}

fn create_mint(
    program: &BenchmarkProgram,
    payer: &Keypair,
    mint_authority: Pubkey,
    decimals: u8,
) -> TestResult<Keypair> {
    let mint = Keypair::new();
    let rent = program.rpc().get_minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN)?;
    let recent_blockhash = program.rpc().get_latest_blockhash()?;

    let create_ix = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        rent,
        spl_token::state::Mint::LEN as u64,
        &spl_token::ID,
    );
    let init_ix = spl_token::instruction::initialize_mint(
        &spl_token::ID,
        &mint.pubkey(),
        &mint_authority,
        None,
        decimals,
    )?;

    let transaction = Transaction::new_signed_with_payer(
        &[create_ix, init_ix],
        Some(&payer.pubkey()),
        &[payer, &mint],
        recent_blockhash,
    );
    program.rpc().send_and_confirm_transaction(&transaction)?;
    Ok(mint)
}

fn create_associated_token_account(
    program: &BenchmarkProgram,
    payer: &Keypair,
    owner: Pubkey,
    mint: Pubkey,
) -> TestResult<Pubkey> {
    let ata = spl_associated_token_account::get_associated_token_address(&owner, &mint);
    let ix = spl_associated_token_account::instruction::create_associated_token_account(
        &payer.pubkey(),
        &owner,
        &mint,
        &spl_token::ID,
    );

    let recent_blockhash = program.rpc().get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    program.rpc().send_and_confirm_transaction(&transaction)?;
    Ok(ata)
}

fn mint_tokens(
    program: &BenchmarkProgram,
    payer: &Keypair,
    mint: Pubkey,
    destination: Pubkey,
    amount: u64,
) -> TestResult<()> {
    let ix = spl_token::instruction::mint_to(
        &spl_token::ID,
        &mint,
        &destination,
        &payer.pubkey(),
        &[],
        amount,
    )?;

    let recent_blockhash = program.rpc().get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    program.rpc().send_and_confirm_transaction(&transaction)?;
    Ok(())
}

fn fund_system_account(
    program: &BenchmarkProgram,
    payer: &Keypair,
    recipient: Pubkey,
    lamports: u64,
) -> TestResult<()> {
    let ix = system_instruction::transfer(&payer.pubkey(), &recipient, lamports);
    let recent_blockhash = program.rpc().get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    program.rpc().send_and_confirm_transaction(&transaction)?;
    Ok(())
}

fn resolve_wallet_path(raw_path: &str) -> PathBuf {
    if let Some(stripped) = raw_path.strip_prefix("~/") {
        let home = env::var("HOME").expect("HOME should be set when ANCHOR_WALLET uses ~");
        return PathBuf::from(home).join(stripped);
    }

    let candidate = PathBuf::from(raw_path);
    if candidate.is_absolute() {
        return candidate;
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(candidate)
}

fn websocket_url(cluster_url: &str) -> String {
    if let Some(stripped) = cluster_url.strip_prefix("http://") {
        return format!("ws://{stripped}");
    }

    if let Some(stripped) = cluster_url.strip_prefix("https://") {
        return format!("wss://{stripped}");
    }

    cluster_url.to_string()
}
