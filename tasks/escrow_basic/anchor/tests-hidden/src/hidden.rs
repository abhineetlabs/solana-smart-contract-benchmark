use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    cancel, exchange, initialize_escrow, initialize_with_amounts, setup, DESIRED_AMOUNT,
    OFFERED_AMOUNT,
};

#[test]
fn initialize_rejects_zero_amounts() {
    let context = setup().expect("setup succeeds");

    let zero_offered = initialize_with_amounts(&context, 0, DESIRED_AMOUNT);
    assert!(zero_offered.is_err(), "zero offered amount should be rejected");

    let zero_desired = initialize_with_amounts(&context, OFFERED_AMOUNT, 0);
    assert!(zero_desired.is_err(), "zero desired amount should be rejected");
}

#[test]
fn attacker_cannot_cancel_to_their_own_token_account() {
    let context = setup().expect("setup succeeds");

    initialize_escrow(&context).expect("initialize succeeds");

    let result = cancel(
        &context,
        context.attacker.pubkey(),
        Some(&context.attacker),
        context.attacker_offered_token,
    );
    assert!(result.is_err(), "unauthorized cancel should fail");
}

#[test]
fn exchange_rejects_wrong_requested_mint() {
    let context = setup().expect("setup succeeds");

    initialize_escrow(&context).expect("initialize succeeds");

    let result = exchange(
        &context,
        context.maker,
        context.maker_alternate_token,
        context.taker.pubkey(),
        Some(&context.taker),
        context.taker_alternate_token,
        context.taker_offered_token,
        context.alternate_mint.pubkey(),
    );
    assert!(result.is_err(), "wrong desired mint should be rejected");
}
