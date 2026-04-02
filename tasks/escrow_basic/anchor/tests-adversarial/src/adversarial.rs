use anchor_client::solana_sdk::signature::Signer;

use crate::common::{exchange, exchange_default, initialize_escrow, setup};

#[test]
fn exchange_rejects_fake_maker_account() {
    let context = setup().expect("setup succeeds");

    initialize_escrow(&context).expect("initialize succeeds");

    let result = exchange(
        &context,
        context.attacker.pubkey(),
        context.attacker_desired_token,
        context.taker.pubkey(),
        Some(&context.taker),
        context.taker_desired_token,
        context.taker_offered_token,
        context.desired_mint.pubkey(),
    );
    assert!(result.is_err(), "fake maker should not receive payout");
}

#[test]
fn exchange_rejects_redirected_payout_account() {
    let context = setup().expect("setup succeeds");

    initialize_escrow(&context).expect("initialize succeeds");

    let result = exchange(
        &context,
        context.maker,
        context.attacker_desired_token,
        context.taker.pubkey(),
        Some(&context.taker),
        context.taker_desired_token,
        context.taker_offered_token,
        context.desired_mint.pubkey(),
    );
    assert!(result.is_err(), "attacker-controlled payout account should be rejected");
}

#[test]
fn exchange_cannot_be_replayed_after_success() {
    let context = setup().expect("setup succeeds");

    initialize_escrow(&context).expect("initialize succeeds");
    exchange_default(&context).expect("first exchange succeeds");

    let replay = exchange_default(&context);
    assert!(replay.is_err(), "escrow should not be reusable after settlement");
}
