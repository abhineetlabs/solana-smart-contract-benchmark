use solana_sdk::signature::Signer;

use crate::common::{
    clone_keypair, deposit, deposit_default, initialize_vault, setup, withdraw, DEPOSIT_AMOUNT,
};

#[tokio::test]
async fn movement_rejects_zero_amounts() {
    let mut context = setup().await.expect("setup succeeds");
    let user = clone_keypair(&context.user);
    let user_pubkey = user.pubkey();
    let mint = context.mint.pubkey();
    let user_token = context.user_token;
    let user_receipt = context.user_receipt;

    initialize_vault(&mut context)
        .await
        .expect("initialize succeeds");

    let zero_deposit = deposit(
        &mut context,
        user_pubkey,
        &user,
        mint,
        user_token,
        user_receipt,
        0,
    )
    .await;
    assert!(zero_deposit.is_err(), "zero deposit should be rejected");

    deposit_default(&mut context)
        .await
        .expect("deposit succeeds");
    let zero_withdraw = withdraw(
        &mut context,
        user_pubkey,
        &user,
        mint,
        user_token,
        user_receipt,
        0,
    )
    .await;
    assert!(zero_withdraw.is_err(), "zero withdraw should be rejected");
}

#[tokio::test]
async fn user_cannot_withdraw_more_than_receipt_balance() {
    let mut context = setup().await.expect("setup succeeds");
    let user = clone_keypair(&context.user);
    let user_pubkey = user.pubkey();
    let mint = context.mint.pubkey();
    let user_token = context.user_token;
    let user_receipt = context.user_receipt;

    initialize_vault(&mut context)
        .await
        .expect("initialize succeeds");
    deposit_default(&mut context)
        .await
        .expect("deposit succeeds");

    let result = withdraw(
        &mut context,
        user_pubkey,
        &user,
        mint,
        user_token,
        user_receipt,
        DEPOSIT_AMOUNT + 1,
    )
    .await;
    assert!(result.is_err(), "over-withdrawal should fail");
}

#[tokio::test]
async fn user_cannot_withdraw_from_someone_elses_receipt() {
    let mut context = setup().await.expect("setup succeeds");
    let other_user = clone_keypair(&context.other_user);
    let other_user_pubkey = other_user.pubkey();
    let attacker = clone_keypair(&context.attacker);
    let attacker_pubkey = attacker.pubkey();
    let mint = context.mint.pubkey();
    let other_user_token = context.other_user_token;
    let other_user_receipt = context.other_user_receipt;
    let attacker_token = context.attacker_token;

    initialize_vault(&mut context)
        .await
        .expect("initialize succeeds");
    deposit(
        &mut context,
        other_user_pubkey,
        &other_user,
        mint,
        other_user_token,
        other_user_receipt,
        DEPOSIT_AMOUNT,
    )
    .await
    .expect("other user deposit succeeds");

    let result = withdraw(
        &mut context,
        attacker_pubkey,
        &attacker,
        mint,
        attacker_token,
        other_user_receipt,
        DEPOSIT_AMOUNT,
    )
    .await;
    assert!(result.is_err(), "attacker should not control another user's receipt");
}
