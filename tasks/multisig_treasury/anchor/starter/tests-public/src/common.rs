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
use multisig_treasury::{accounts, instruction, Multisig, Proposal, ID};

pub type BenchmarkProgram = Program<Rc<Keypair>>;
pub type TestResult<T> = Result<T, Box<dyn Error>>;

pub const DEFAULT_SEED: u64 = 21;
pub const THRESHOLD: u8 = 2;
pub const TREASURY_FUNDS: u64 = 40;
pub const TRANSFER_AMOUNT: u64 = 15;

static NEXT_SEED: AtomicU64 = AtomicU64::new(DEFAULT_SEED);

pub struct TestContext {
    pub program: BenchmarkProgram,
    pub payer: Rc<Keypair>,
    pub creator: Pubkey,
    pub owner_one: Keypair,
    pub owner_two: Keypair,
    pub attacker: Keypair,
    pub recipient: Keypair,
    pub seed: u64,
    pub mint: Keypair,
    pub recipient_token: Pubkey,
    pub attacker_token: Pubkey,
    pub multisig: Pubkey,
    pub vault_authority: Pubkey,
    pub vault: Pubkey,
}

pub fn setup() -> TestResult<TestContext> {
    let cluster_url = env::var("ANCHOR_PROVIDER_URL")?;
    let wallet_path = resolve_wallet_path(&env::var("ANCHOR_WALLET")?);
    let payer = Rc::new(read_keypair_file(&wallet_path)?);
    let creator = payer.pubkey();
    let websocket_url = websocket_url(&cluster_url);
    let client = Client::new_with_options(
        Cluster::Custom(cluster_url, websocket_url),
        payer.clone(),
        CommitmentConfig::confirmed(),
    );
    let program = client.program(ID)?;

    let owner_one = Keypair::new();
    let owner_two = Keypair::new();
    let attacker = Keypair::new();
    let recipient = Keypair::new();
    fund_system_account(&program, payer.as_ref(), owner_one.pubkey(), 2_000_000_000)?;
    fund_system_account(&program, payer.as_ref(), owner_two.pubkey(), 2_000_000_000)?;
    fund_system_account(&program, payer.as_ref(), attacker.pubkey(), 2_000_000_000)?;
    fund_system_account(&program, payer.as_ref(), recipient.pubkey(), 2_000_000_000)?;

    let mint = create_mint(&program, payer.as_ref(), creator, 0)?;
    let recipient_token =
        create_associated_token_account(&program, payer.as_ref(), recipient.pubkey(), mint.pubkey())?;
    let attacker_token =
        create_associated_token_account(&program, payer.as_ref(), attacker.pubkey(), mint.pubkey())?;

    let seed = NEXT_SEED.fetch_add(1, Ordering::Relaxed);
    let (multisig, vault_authority) = derive_multisig_addresses(creator, seed);
    let vault =
        spl_associated_token_account::get_associated_token_address(&vault_authority, &mint.pubkey());

    Ok(TestContext {
        program,
        payer,
        creator,
        owner_one,
        owner_two,
        attacker,
        recipient,
        seed,
        mint,
        recipient_token,
        attacker_token,
        multisig,
        vault_authority,
        vault,
    })
}

pub fn owners(context: &TestContext) -> Vec<Pubkey> {
    vec![context.creator, context.owner_one.pubkey(), context.owner_two.pubkey()]
}

pub fn initialize_multisig(context: &TestContext) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::Initialize {
            creator: context.creator,
            mint: context.mint.pubkey(),
            multisig: context.multisig,
            vault_authority: context.vault_authority,
            vault: context.vault,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        })
        .args(instruction::Initialize {
            seed: context.seed,
            owners: owners(context),
            threshold: THRESHOLD,
        })
        .send()?)
}

pub fn fund_treasury(context: &TestContext, amount: u64) -> TestResult<()> {
    mint_tokens(
        &context.program,
        context.payer.as_ref(),
        context.mint.pubkey(),
        context.vault,
        amount,
    )
}

pub fn propose_default(context: &TestContext) -> TestResult<Signature> {
    propose_transfer(
        context,
        context.owner_one.pubkey(),
        Some(&context.owner_one),
        context.recipient.pubkey(),
        0,
        TRANSFER_AMOUNT,
    )
}

pub fn propose_transfer(
    context: &TestContext,
    proposer: Pubkey,
    signer: Option<&Keypair>,
    recipient: Pubkey,
    proposal_id: u64,
    amount: u64,
) -> TestResult<Signature> {
    let proposal = proposal_address(context.multisig, proposal_id);
    let mut request = context
        .program
        .request()
        .accounts(accounts::ProposeTransfer {
            proposer,
            multisig: context.multisig,
            proposal,
            recipient,
            system_program: system_program::ID,
        })
        .args(instruction::ProposeTransfer { proposal_id, amount });

    if let Some(signer) = signer {
        request = request.signer(signer);
    }

    Ok(request.send()?)
}

pub fn approve_default(context: &TestContext) -> TestResult<Signature> {
    approve(context, context.owner_two.pubkey(), Some(&context.owner_two), 0)
}

pub fn approve(
    context: &TestContext,
    owner: Pubkey,
    signer: Option<&Keypair>,
    proposal_id: u64,
) -> TestResult<Signature> {
    let proposal = proposal_address(context.multisig, proposal_id);
    let mut request = context
        .program
        .request()
        .accounts(accounts::Approve {
            owner,
            multisig: context.multisig,
            proposal,
        })
        .args(instruction::Approve {});

    if let Some(signer) = signer {
        request = request.signer(signer);
    }

    Ok(request.send()?)
}

pub fn execute_default(context: &TestContext) -> TestResult<Signature> {
    execute(
        context,
        context.creator,
        None,
        0,
        context.recipient.pubkey(),
        context.recipient_token,
    )
}

pub fn execute(
    context: &TestContext,
    owner: Pubkey,
    signer: Option<&Keypair>,
    proposal_id: u64,
    recipient: Pubkey,
    recipient_token: Pubkey,
) -> TestResult<Signature> {
    let proposal = proposal_address(context.multisig, proposal_id);
    let mut request = context
        .program
        .request()
        .accounts(accounts::Execute {
            owner,
            multisig: context.multisig,
            proposal,
            vault_authority: context.vault_authority,
            mint: context.mint.pubkey(),
            vault: context.vault,
            recipient,
            recipient_token,
            token_program: spl_token::ID,
        })
        .args(instruction::Execute {});

    if let Some(signer) = signer {
        request = request.signer(signer);
    }

    Ok(request.send()?)
}

pub fn fetch_multisig(context: &TestContext) -> TestResult<Multisig> {
    Ok(context.program.account(context.multisig)?)
}

pub fn fetch_proposal(context: &TestContext, proposal_id: u64) -> TestResult<Proposal> {
    Ok(context.program.account(proposal_address(context.multisig, proposal_id))?)
}

pub fn token_balance(context: &TestContext, token_account: Pubkey) -> TestResult<u64> {
    let account = context.program.rpc().get_account(&token_account)?;
    let parsed = spl_token::state::Account::unpack(&account.data)?;
    Ok(parsed.amount)
}

pub fn account_exists(context: &TestContext, account: Pubkey) -> bool {
    context.program.rpc().get_account(&account).is_ok()
}

pub fn proposal_address(multisig: Pubkey, proposal_id: u64) -> Pubkey {
    let proposal_bytes = proposal_id.to_le_bytes();
    Pubkey::find_program_address(&[b"proposal", multisig.as_ref(), &proposal_bytes], &ID).0
}

fn derive_multisig_addresses(creator: Pubkey, seed: u64) -> (Pubkey, Pubkey) {
    let seed_bytes = seed.to_le_bytes();
    let (multisig, _) =
        Pubkey::find_program_address(&[b"multisig", creator.as_ref(), &seed_bytes], &ID);
    let (vault_authority, _) =
        Pubkey::find_program_address(&[b"vault_authority", multisig.as_ref()], &ID);
    (multisig, vault_authority)
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
