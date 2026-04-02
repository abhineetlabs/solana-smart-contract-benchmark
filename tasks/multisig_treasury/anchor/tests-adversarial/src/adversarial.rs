use anchor_client::solana_sdk::signature::Signer;

use crate::common::{approve_default, execute, execute_default, fund_treasury, initialize_multisig, propose_default, setup, TREASURY_FUNDS};

#[test]
fn execute_rejects_redirected_payout_account() {
    let context = setup().expect("setup succeeds");

    initialize_multisig(&context).expect("initialize succeeds");
    fund_treasury(&context, TREASURY_FUNDS).expect("funding succeeds");
    propose_default(&context).expect("proposal succeeds");
    approve_default(&context).expect("approval succeeds");

    let result = execute(
        &context,
        context.creator,
        None,
        0,
        context.recipient.pubkey(),
        context.attacker_token,
    );
    assert!(result.is_err(), "recipient payout should not be redirectable");
}

#[test]
fn attacker_cannot_execute_even_after_threshold() {
    let context = setup().expect("setup succeeds");

    initialize_multisig(&context).expect("initialize succeeds");
    fund_treasury(&context, TREASURY_FUNDS).expect("funding succeeds");
    propose_default(&context).expect("proposal succeeds");
    approve_default(&context).expect("approval succeeds");

    let result = execute(
        &context,
        context.attacker.pubkey(),
        Some(&context.attacker),
        0,
        context.recipient.pubkey(),
        context.recipient_token,
    );
    assert!(result.is_err(), "non-owner execution should fail");
}

#[test]
fn executed_proposal_cannot_be_replayed() {
    let context = setup().expect("setup succeeds");

    initialize_multisig(&context).expect("initialize succeeds");
    fund_treasury(&context, TREASURY_FUNDS).expect("funding succeeds");
    propose_default(&context).expect("proposal succeeds");
    approve_default(&context).expect("approval succeeds");
    execute_default(&context).expect("first execution succeeds");

    let replay = execute_default(&context);
    assert!(replay.is_err(), "closed proposal should not execute twice");
}
