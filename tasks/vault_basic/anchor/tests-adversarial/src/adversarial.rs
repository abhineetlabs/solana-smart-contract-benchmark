use anchor_client::solana_sdk::signature::Signer;

use crate::common::{deposit, deposit_default, initialize_vault, set_paused_as, setup, withdraw, DEPOSIT_AMOUNT};

#[test]
fn withdraw_rejects_redirected_destination_account() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("initialize succeeds");
    deposit_default(&context).expect("deposit succeeds");

    let result = withdraw(
        &context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.attacker_token,
        context.user_receipt,
        DEPOSIT_AMOUNT,
    );
    assert!(result.is_err(), "withdraw should not allow attacker-owned destination accounts");
}

#[test]
fn attacker_cannot_pause_the_vault() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("initialize succeeds");

    let result = set_paused_as(
        &context,
        context.attacker.pubkey(),
        Some(&context.attacker),
        true,
    );
    assert!(result.is_err(), "non-admin pause should fail");
}

#[test]
fn deposit_rejects_wrong_mint_source_account() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("initialize succeeds");

    let result = deposit(
        &context,
        context.user.pubkey(),
        &context.user,
        context.alternate_mint.pubkey(),
        context.user_alternate_token,
        context.user_receipt,
        DEPOSIT_AMOUNT,
    );
    assert!(result.is_err(), "wrong mint deposit should be rejected");
}
