use std::{env, path::PathBuf, rc::Rc};

use anchor_client::{
    solana_sdk::{
        commitment_config::CommitmentConfig,
        pubkey::Pubkey,
        signature::{read_keypair_file, Keypair, Signature, Signer},
        system_program,
    },
    Client, ClientError, Cluster, Program,
};
use counter_authority::{accounts, instruction, ID};

pub type BenchmarkProgram = Program<Rc<Keypair>>;

pub fn setup() -> (BenchmarkProgram, Pubkey, Keypair, Keypair) {
    let cluster_url = env::var("ANCHOR_PROVIDER_URL").expect("ANCHOR_PROVIDER_URL is set by anchor test");
    let wallet_path = resolve_wallet_path(
        &env::var("ANCHOR_WALLET").expect("ANCHOR_WALLET is set by anchor test"),
    );
    let payer = Rc::new(read_keypair_file(&wallet_path).expect("wallet can be read"));
    let authority = payer.pubkey();
    let websocket_url = websocket_url(&cluster_url);
    let client = Client::new_with_options(
        Cluster::Custom(cluster_url, websocket_url),
        payer,
        CommitmentConfig::confirmed(),
    );
    let program = client.program(ID).expect("program client is available");

    (program, authority, Keypair::new(), Keypair::new())
}

pub fn initialize_counter(
    program: &BenchmarkProgram,
    authority: Pubkey,
    counter: &Keypair,
) -> Result<Signature, ClientError> {
    program
        .request()
        .accounts(accounts::Initialize {
            counter: counter.pubkey(),
            authority,
            system_program: system_program::ID,
        })
        .args(instruction::Initialize {})
        .signer(counter)
        .send()
}

pub fn increment_counter(
    program: &BenchmarkProgram,
    authority: Pubkey,
    signer: Option<&Keypair>,
    counter: Pubkey,
) -> Result<Signature, ClientError> {
    let mut request = program
        .request()
        .accounts(accounts::Increment { counter, authority })
        .args(instruction::Increment {});
    if let Some(signer) = signer {
        request = request.signer(signer);
    }

    request.send()
}

pub fn set_authority(
    program: &BenchmarkProgram,
    authority: Pubkey,
    signer: Option<&Keypair>,
    counter: Pubkey,
    new_authority: Pubkey,
) -> Result<Signature, ClientError> {
    let mut request = program
        .request()
        .accounts(accounts::SetAuthority { counter, authority })
        .args(instruction::SetAuthority { new_authority });
    if let Some(signer) = signer {
        request = request.signer(signer);
    }

    request.send()
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
