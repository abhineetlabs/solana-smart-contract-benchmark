use anchor_client::solana_sdk::signature::Signer;

use crate::common::{approve, fund_treasury, initialize_multisig, propose_default, propose_transfer, setup, execute, TREASURY_FUNDS};

#[test]
fn non_owner_cannot_create_proposal() {
    let context = setup().expect("setup succeeds");

    initialize_multisig(&context).expect("initialize succeeds");
    fund_treasury(&context, TREASURY_FUNDS).expect("funding succeeds");

    let result = propose_transfer(
        &context,
        context.attacker.pubkey(),
        Some(&context.attacker),
        context.recipient.pubkey(),
        0,
        5,
    );
    assert!(result.is_err(), "non-owner proposal should fail");
}

#[test]
fn duplicate_approval_is_rejected() {
    let context = setup().expect("setup succeeds");

    initialize_multisig(&context).expect("initialize succeeds");
    fund_treasury(&context, TREASURY_FUNDS).expect("funding succeeds");
    propose_default(&context).expect("proposal succeeds");
    approve(&context, context.owner_two.pubkey(), Some(&context.owner_two), 0)
        .expect("first approval succeeds");

    let duplicate = approve(&context, context.owner_two.pubkey(), Some(&context.owner_two), 0);
    assert!(duplicate.is_err(), "duplicate approval should fail");
}

#[test]
fn execution_fails_before_threshold() {
    let context = setup().expect("setup succeeds");

    initialize_multisig(&context).expect("initialize succeeds");
    fund_treasury(&context, TREASURY_FUNDS).expect("funding succeeds");
    propose_default(&context).expect("proposal succeeds");

    let result = execute(
        &context,
        context.creator,
        None,
        0,
        context.recipient.pubkey(),
        context.recipient_token,
    );
    assert!(result.is_err(), "execution should fail without enough approvals");
}
