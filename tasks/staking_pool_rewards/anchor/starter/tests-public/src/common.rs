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
use staking_pool_rewards::{accounts, instruction, Pool, Position, ID};

pub type BenchmarkProgram = Program<Rc<Keypair>>;
pub type TestResult<T> = Result<T, Box<dyn Error>>;

pub const DEFAULT_SEED: u64 = 41;
pub const INITIAL_USER_STAKE: u64 = 500;
pub const INITIAL_SECOND_USER_STAKE: u64 = 400;
pub const INITIAL_ATTACKER_STAKE: u64 = 120;
pub const DEFAULT_STAKE_AMOUNT: u64 = 100;
pub const SECOND_USER_STAKE_AMOUNT: u64 = 300;
pub const FIRST_REWARD_AMOUNT: u64 = 80;
pub const SECOND_REWARD_AMOUNT: u64 = 60;

static NEXT_SEED: AtomicU64 = AtomicU64::new(DEFAULT_SEED);

pub struct TestContext {
    pub program: BenchmarkProgram,
    pub payer: Rc<Keypair>,
    pub admin: Pubkey,
    pub user: Keypair,
    pub second_user: Keypair,
    pub attacker: Keypair,
    pub seed: u64,
    pub stake_mint: Keypair,
    pub reward_mint: Keypair,
    pub admin_reward_token: Pubkey,
    pub user_stake_token: Pubkey,
    pub second_user_stake_token: Pubkey,
    pub attacker_stake_token: Pubkey,
    pub user_reward_token: Pubkey,
    pub second_user_reward_token: Pubkey,
    pub attacker_reward_token: Pubkey,
    pub pool: Pubkey,
    pub pool_authority: Pubkey,
    pub stake_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub user_position: Pubkey,
    pub second_user_position: Pubkey,
    pub attacker_position: Pubkey,
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
    let second_user = Keypair::new();
    let attacker = Keypair::new();
    fund_system_account(&program, payer.as_ref(), user.pubkey(), 2_000_000_000)?;
    fund_system_account(&program, payer.as_ref(), second_user.pubkey(), 2_000_000_000)?;
    fund_system_account(&program, payer.as_ref(), attacker.pubkey(), 2_000_000_000)?;

    let stake_mint = create_mint(&program, payer.as_ref(), admin, 0)?;
    let reward_mint = create_mint(&program, payer.as_ref(), admin, 0)?;

    let admin_reward_token =
        create_associated_token_account(&program, payer.as_ref(), admin, reward_mint.pubkey())?;
    let user_stake_token =
        create_associated_token_account(&program, payer.as_ref(), user.pubkey(), stake_mint.pubkey())?;
    let second_user_stake_token = create_associated_token_account(
        &program,
        payer.as_ref(),
        second_user.pubkey(),
        stake_mint.pubkey(),
    )?;
    let attacker_stake_token = create_associated_token_account(
        &program,
        payer.as_ref(),
        attacker.pubkey(),
        stake_mint.pubkey(),
    )?;
    let user_reward_token =
        create_associated_token_account(&program, payer.as_ref(), user.pubkey(), reward_mint.pubkey())?;
    let second_user_reward_token = create_associated_token_account(
        &program,
        payer.as_ref(),
        second_user.pubkey(),
        reward_mint.pubkey(),
    )?;
    let attacker_reward_token = create_associated_token_account(
        &program,
        payer.as_ref(),
        attacker.pubkey(),
        reward_mint.pubkey(),
    )?;

    mint_tokens(
        &program,
        payer.as_ref(),
        stake_mint.pubkey(),
        user_stake_token,
        INITIAL_USER_STAKE,
    )?;
    mint_tokens(
        &program,
        payer.as_ref(),
        stake_mint.pubkey(),
        second_user_stake_token,
        INITIAL_SECOND_USER_STAKE,
    )?;
    mint_tokens(
        &program,
        payer.as_ref(),
        stake_mint.pubkey(),
        attacker_stake_token,
        INITIAL_ATTACKER_STAKE,
    )?;
    mint_tokens(
        &program,
        payer.as_ref(),
        reward_mint.pubkey(),
        admin_reward_token,
        2_000,
    )?;

    let seed = NEXT_SEED.fetch_add(1, Ordering::Relaxed);
    let (pool, pool_authority) = derive_pool_addresses(admin, seed);
    let stake_vault =
        spl_associated_token_account::get_associated_token_address(&pool_authority, &stake_mint.pubkey());
    let reward_vault =
        spl_associated_token_account::get_associated_token_address(&pool_authority, &reward_mint.pubkey());
    let user_position = derive_position(pool, user.pubkey());
    let second_user_position = derive_position(pool, second_user.pubkey());
    let attacker_position = derive_position(pool, attacker.pubkey());

    Ok(TestContext {
        program,
        payer,
        admin,
        user,
        second_user,
        attacker,
        seed,
        stake_mint,
        reward_mint,
        admin_reward_token,
        user_stake_token,
        second_user_stake_token,
        attacker_stake_token,
        user_reward_token,
        second_user_reward_token,
        attacker_reward_token,
        pool,
        pool_authority,
        stake_vault,
        reward_vault,
        user_position,
        second_user_position,
        attacker_position,
    })
}

pub fn initialize_pool(context: &TestContext) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::Initialize {
            admin: context.admin,
            stake_mint: context.stake_mint.pubkey(),
            reward_mint: context.reward_mint.pubkey(),
            pool: context.pool,
            pool_authority: context.pool_authority,
            stake_vault: context.stake_vault,
            reward_vault: context.reward_vault,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        })
        .args(instruction::Initialize { seed: context.seed })
        .send()?)
}

pub fn deposit_rewards(context: &TestContext, amount: u64) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::DepositRewards {
            admin: context.admin,
            pool: context.pool,
            pool_authority: context.pool_authority,
            reward_mint: context.reward_mint.pubkey(),
            reward_vault: context.reward_vault,
            admin_reward_token: context.admin_reward_token,
            token_program: spl_token::ID,
        })
        .args(instruction::DepositRewards { amount })
        .send()?)
}

pub fn stake_default(context: &TestContext) -> TestResult<Signature> {
    stake_for(
        context,
        context.user.pubkey(),
        &context.user,
        context.user_stake_token,
        context.user_position,
        DEFAULT_STAKE_AMOUNT,
    )
}

pub fn stake_second_user(context: &TestContext) -> TestResult<Signature> {
    stake_for(
        context,
        context.second_user.pubkey(),
        &context.second_user,
        context.second_user_stake_token,
        context.second_user_position,
        SECOND_USER_STAKE_AMOUNT,
    )
}

pub fn stake_for(
    context: &TestContext,
    user: Pubkey,
    signer: &Keypair,
    user_stake_token: Pubkey,
    position: Pubkey,
    amount: u64,
) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::Stake {
            user,
            pool: context.pool,
            pool_authority: context.pool_authority,
            stake_mint: context.stake_mint.pubkey(),
            stake_vault: context.stake_vault,
            user_stake_token,
            position,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        })
        .args(instruction::Stake { amount })
        .signer(signer)
        .send()?)
}

pub fn unstake_for(
    context: &TestContext,
    user: Pubkey,
    signer: &Keypair,
    user_stake_token: Pubkey,
    position: Pubkey,
    amount: u64,
) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::Unstake {
            user,
            pool: context.pool,
            pool_authority: context.pool_authority,
            stake_mint: context.stake_mint.pubkey(),
            stake_vault: context.stake_vault,
            user_stake_token,
            position,
            token_program: spl_token::ID,
        })
        .args(instruction::Unstake { amount })
        .signer(signer)
        .send()?)
}

pub fn claim_for(
    context: &TestContext,
    user: Pubkey,
    signer: &Keypair,
    user_reward_token: Pubkey,
    position: Pubkey,
) -> TestResult<Signature> {
    Ok(context
        .program
        .request()
        .accounts(accounts::Claim {
            user,
            pool: context.pool,
            pool_authority: context.pool_authority,
            reward_mint: context.reward_mint.pubkey(),
            reward_vault: context.reward_vault,
            user_reward_token,
            position,
            token_program: spl_token::ID,
        })
        .args(instruction::Claim {})
        .signer(signer)
        .send()?)
}

pub fn fetch_pool(context: &TestContext) -> TestResult<Pool> {
    Ok(context.program.account(context.pool)?)
}

pub fn fetch_position(context: &TestContext, position: Pubkey) -> TestResult<Position> {
    Ok(context.program.account(position)?)
}

pub fn token_balance(context: &TestContext, token_account: Pubkey) -> TestResult<u64> {
    let account = context.program.rpc().get_account(&token_account)?;
    let parsed = spl_token::state::Account::unpack(&account.data)?;
    Ok(parsed.amount)
}

fn derive_pool_addresses(admin: Pubkey, seed: u64) -> (Pubkey, Pubkey) {
    let seed_bytes = seed.to_le_bytes();
    let (pool, _) = Pubkey::find_program_address(&[b"pool", admin.as_ref(), &seed_bytes], &ID);
    let (pool_authority, _) =
        Pubkey::find_program_address(&[b"pool_authority", pool.as_ref()], &ID);
    (pool, pool_authority)
}

fn derive_position(pool: Pubkey, owner: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position", pool.as_ref(), owner.as_ref()], &ID).0
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
