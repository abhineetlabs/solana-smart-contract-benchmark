use anchor_client::solana_sdk::signature::Signer;

use crate::common::{deposit, deposit_default, initialize_vault, setup, withdraw, DEPOSIT_AMOUNT};

#[test]
fn movement_rejects_zero_amounts() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("initialize succeeds");

    let zero_deposit = deposit(
        &context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.user_token,
        context.user_receipt,
        0,
    );
    assert!(zero_deposit.is_err(), "zero deposit should be rejected");

    deposit_default(&context).expect("deposit succeeds");
    let zero_withdraw = withdraw(
        &context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.user_token,
        context.user_receipt,
        0,
    );
    assert!(zero_withdraw.is_err(), "zero withdraw should be rejected");
}

#[test]
fn user_cannot_withdraw_more_than_receipt_balance() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("initialize succeeds");
    deposit_default(&context).expect("deposit succeeds");

    let result = withdraw(
        &context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.user_token,
        context.user_receipt,
        DEPOSIT_AMOUNT + 1,
    );
    assert!(result.is_err(), "over-withdrawal should fail");
}

#[test]
fn user_cannot_withdraw_from_someone_elses_receipt() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("initialize succeeds");
    deposit(
        &context,
        context.other_user.pubkey(),
        &context.other_user,
        context.mint.pubkey(),
        context.other_user_token,
        context.other_user_receipt,
        DEPOSIT_AMOUNT,
    )
    .expect("other user deposit succeeds");

    let result = withdraw(
        &context,
        context.attacker.pubkey(),
        &context.attacker,
        context.mint.pubkey(),
        context.attacker_token,
        context.other_user_receipt,
        DEPOSIT_AMOUNT,
    );
    assert!(result.is_err(), "attacker should not control another user's receipt");
}
