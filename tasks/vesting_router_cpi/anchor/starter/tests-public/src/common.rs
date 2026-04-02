use std::{env, error::Error, path::PathBuf, rc::Rc, sync::atomic::{AtomicU64, Ordering}};

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
use guarded_vault::{
    accounts as helper_accounts,
    instruction as helper_instruction,
    ID as GUARDED_VAULT_ID,
};
use vesting_router_cpi::{accounts, instruction, Stream, ID as ROUTER_ID};

pub type BenchmarkProgram = Program<Rc<Keypair>>;
pub type TestResult<T> = Result<T, Box<dyn Error>>;

pub const DEFAULT_SEED: u64 = 73;
pub const TOTAL_AMOUNT: u64 = 200;
pub const CLIFF_ROUND: u64 = 1;
pub const TOTAL_ROUNDS: u64 = 4;
pub const FIRST_TRANCHE: u64 = 50;
pub const SECOND_TRANCHE_TOTAL: u64 = 100;
pub const ALT_VAULT_SEED: u64 = 997;

static NEXT_SEED: AtomicU64 = AtomicU64::new(DEFAULT_SEED);

pub struct TestContext {
    pub router_program: BenchmarkProgram,
    pub helper_program: BenchmarkProgram,
    pub payer: Rc<Keypair>,
    pub admin: Pubkey,
    pub beneficiary: Keypair,
    pub attacker: Keypair,
    pub seed: u64,
    pub mint: Keypair,
    pub admin_token: Pubkey,
    pub beneficiary_token: Pubkey,
    pub attacker_token: Pubkey,
    pub stream: Pubkey,
    pub router_authority: Pubkey,
    pub vault: Pubkey,
    pub vault_authority: Pubkey,
    pub vault_token: Pubkey,
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
    let router_program = client.program(ROUTER_ID)?;
    let helper_program = client.program(GUARDED_VAULT_ID)?;

    let beneficiary = Keypair::new();
    let attacker = Keypair::new();
    fund_system_account(&router_program, payer.as_ref(), beneficiary.pubkey(), 2_000_000_000)?;
    fund_system_account(&router_program, payer.as_ref(), attacker.pubkey(), 2_000_000_000)?;

    let mint = create_mint(&router_program, payer.as_ref(), admin, 0)?;
    let admin_token =
        create_associated_token_account(&router_program, payer.as_ref(), admin, mint.pubkey())?;
    let beneficiary_token = create_associated_token_account(
        &router_program,
        payer.as_ref(),
        beneficiary.pubkey(),
        mint.pubkey(),
    )?;
    let attacker_token = create_associated_token_account(
        &router_program,
        payer.as_ref(),
        attacker.pubkey(),
        mint.pubkey(),
    )?;

    mint_tokens(
        &router_program,
        payer.as_ref(),
        mint.pubkey(),
        admin_token,
        2_000,
    )?;

    let seed = NEXT_SEED.fetch_add(1, Ordering::Relaxed);
    let (stream, router_authority) = derive_stream_addresses(admin, seed);
    let (vault, vault_authority, vault_token) = derive_helper_vault_addresses(router_authority, seed, mint.pubkey());

    Ok(TestContext {
        router_program,
        helper_program,
        payer,
        admin,
        beneficiary,
        attacker,
        seed,
        mint,
        admin_token,
        beneficiary_token,
        attacker_token,
        stream,
        router_authority,
        vault,
        vault_authority,
        vault_token,
    })
}

pub fn initialize_stream(context: &TestContext) -> TestResult<Signature> {
    Ok(context
        .router_program
        .request()
        .accounts(accounts::InitializeStream {
            admin: context.admin,
            beneficiary: context.beneficiary.pubkey(),
            mint: context.mint.pubkey(),
            stream: context.stream,
            router_authority: context.router_authority,
            guarded_vault_program: GUARDED_VAULT_ID,
            vault: context.vault,
            vault_authority: context.vault_authority,
            vault_token: context.vault_token,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        })
        .args(instruction::InitializeStream {
            seed: context.seed,
            total_amount: TOTAL_AMOUNT,
            cliff_round: CLIFF_ROUND,
            total_rounds: TOTAL_ROUNDS,
        })
        .send()?)
}

pub fn fund_stream(context: &TestContext) -> TestResult<Signature> {
    Ok(context
        .router_program
        .request()
        .accounts(accounts::Fund {
            admin: context.admin,
            stream: context.stream,
            mint: context.mint.pubkey(),
            admin_token: context.admin_token,
            vault_token: context.vault_token,
            token_program: spl_token::ID,
        })
        .args(instruction::Fund {})
        .send()?)
}

pub fn advance_round(context: &TestContext, new_round: u64) -> TestResult<Signature> {
    advance_round_as(context, context.admin, None, new_round)
}

pub fn advance_round_as(
    context: &TestContext,
    admin: Pubkey,
    signer: Option<&Keypair>,
    new_round: u64,
) -> TestResult<Signature> {
    let mut request = context
        .router_program
        .request()
        .accounts(accounts::AdvanceRound {
            admin,
            stream: context.stream,
        })
        .args(instruction::AdvanceRound { new_round });

    if let Some(signer) = signer {
        request = request.signer(signer);
    }

    Ok(request.send()?)
}

pub fn claim_default(context: &TestContext) -> TestResult<Signature> {
    claim_with_accounts(
        context,
        context.beneficiary.pubkey(),
        &context.beneficiary,
        context.beneficiary_token,
        context.vault,
        context.vault_authority,
        context.vault_token,
    )
}

pub fn claim_with_accounts(
    context: &TestContext,
    beneficiary: Pubkey,
    signer: &Keypair,
    payout_token: Pubkey,
    vault: Pubkey,
    vault_authority: Pubkey,
    vault_token: Pubkey,
) -> TestResult<Signature> {
    Ok(context
        .router_program
        .request()
        .accounts(accounts::Claim {
            beneficiary,
            stream: context.stream,
            router_authority: context.router_authority,
            guarded_vault_program: GUARDED_VAULT_ID,
            vault,
            vault_authority,
            mint: context.mint.pubkey(),
            vault_token,
            beneficiary_token: payout_token,
            token_program: spl_token::ID,
        })
        .args(instruction::Claim {})
        .signer(signer)
        .send()?)
}

pub fn initialize_alternate_vault(
    context: &TestContext,
    seed: u64,
) -> TestResult<(Pubkey, Pubkey, Pubkey)> {
    let (vault, vault_authority, vault_token) =
        derive_helper_vault_addresses(context.router_authority, seed, context.mint.pubkey());

    context
        .helper_program
        .request()
        .accounts(helper_accounts::InitializeVault {
            admin: context.admin,
            controller: context.router_authority,
            mint: context.mint.pubkey(),
            vault,
            vault_authority,
            vault_token,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        })
        .args(helper_instruction::InitializeVault {
            seed,
            controller: context.router_authority,
        })
        .send()?;

    Ok((vault, vault_authority, vault_token))
}

pub fn direct_fund_vault(
    context: &TestContext,
    target_vault_token: Pubkey,
    amount: u64,
) -> TestResult<()> {
    let ix = spl_token::instruction::transfer_checked(
        &spl_token::ID,
        &context.admin_token,
        &context.mint.pubkey(),
        &target_vault_token,
        &context.admin,
        &[],
        amount,
        0,
    )?;

    let recent_blockhash = context.router_program.rpc().get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.admin),
        &[context.payer.as_ref()],
        recent_blockhash,
    );
    context.router_program.rpc().send_and_confirm_transaction(&transaction)?;
    Ok(())
}

pub fn fetch_stream(context: &TestContext) -> TestResult<Stream> {
    Ok(context.router_program.account(context.stream)?)
}

pub fn token_balance(context: &TestContext, token_account: Pubkey) -> TestResult<u64> {
    let account = context.router_program.rpc().get_account(&token_account)?;
    let parsed = spl_token::state::Account::unpack(&account.data)?;
    Ok(parsed.amount)
}

fn derive_stream_addresses(admin: Pubkey, seed: u64) -> (Pubkey, Pubkey) {
    let seed_bytes = seed.to_le_bytes();
    let (stream, _) = Pubkey::find_program_address(&[b"stream", admin.as_ref(), &seed_bytes], &ROUTER_ID);
    let (router_authority, _) =
        Pubkey::find_program_address(&[b"router_authority", stream.as_ref()], &ROUTER_ID);
    (stream, router_authority)
}

fn derive_helper_vault_addresses(
    router_authority: Pubkey,
    seed: u64,
    mint: Pubkey,
) -> (Pubkey, Pubkey, Pubkey) {
    let seed_bytes = seed.to_le_bytes();
    let (vault, _) =
        Pubkey::find_program_address(&[b"vault", router_authority.as_ref(), &seed_bytes], &GUARDED_VAULT_ID);
    let (vault_authority, _) =
        Pubkey::find_program_address(&[b"vault_authority", vault.as_ref()], &GUARDED_VAULT_ID);
    let vault_token =
        spl_associated_token_account::get_associated_token_address(&vault_authority, &mint);
    (vault, vault_authority, vault_token)
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
