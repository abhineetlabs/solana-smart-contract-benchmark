use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    account_exists, approve_default, execute_default, fetch_multisig, fetch_proposal, fund_treasury,
    initialize_multisig, proposal_address, propose_default, setup, token_balance, owners,
    THRESHOLD, TRANSFER_AMOUNT, TREASURY_FUNDS,
};

#[test]
fn initialize_records_owner_set_and_threshold() {
    let context = setup().expect("setup succeeds");

    initialize_multisig(&context).expect("initialize succeeds");

    let multisig = fetch_multisig(&context).expect("multisig can be fetched");
    assert_eq!(multisig.creator, context.creator);
    assert_eq!(multisig.mint, context.mint.pubkey());
    assert_eq!(multisig.threshold, THRESHOLD);
    assert_eq!(multisig.owners, owners(&context));
    assert_eq!(multisig.next_proposal_id, 0);
    assert_eq!(
        token_balance(&context, context.vault).expect("vault balance can be read"),
        0,
    );
}

#[test]
fn threshold_approved_proposal_transfers_funds() {
    let context = setup().expect("setup succeeds");

    initialize_multisig(&context).expect("initialize succeeds");
    fund_treasury(&context, TREASURY_FUNDS).expect("funding succeeds");
    propose_default(&context).expect("proposal succeeds");
    approve_default(&context).expect("approval succeeds");
    execute_default(&context).expect("execution succeeds");

    assert_eq!(
        token_balance(&context, context.recipient_token).expect("recipient balance can be read"),
        TRANSFER_AMOUNT,
    );
    assert_eq!(
        token_balance(&context, context.vault).expect("vault balance can be read"),
        TREASURY_FUNDS - TRANSFER_AMOUNT,
    );
}

#[test]
fn proposal_tracks_auto_approval_and_closes_on_execute() {
    let context = setup().expect("setup succeeds");

    initialize_multisig(&context).expect("initialize succeeds");
    fund_treasury(&context, TREASURY_FUNDS).expect("funding succeeds");
    propose_default(&context).expect("proposal succeeds");

    let proposal = fetch_proposal(&context, 0).expect("proposal can be fetched");
    let multisig = fetch_multisig(&context).expect("multisig can be fetched");
    assert!(proposal.approvals[1], "proposer should count as approved");
    assert_eq!(multisig.next_proposal_id, 1);

    approve_default(&context).expect("approval succeeds");
    execute_default(&context).expect("execution succeeds");

    assert!(
        !account_exists(&context, proposal_address(context.multisig, 0)),
        "proposal account should be closed after execution"
    );
}
