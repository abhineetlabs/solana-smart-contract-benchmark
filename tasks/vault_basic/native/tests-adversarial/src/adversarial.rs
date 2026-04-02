use solana_sdk::signature::Signer;

use crate::common::{
    clone_keypair, deposit, deposit_default, initialize_vault, set_paused_as, setup, withdraw,
    DEPOSIT_AMOUNT,
};

#[tokio::test]
async fn withdraw_rejects_redirected_destination_account() {
    let mut context = setup().await.expect("setup succeeds");
    let user = clone_keypair(&context.user);
    let user_pubkey = user.pubkey();
    let mint = context.mint.pubkey();
    let attacker_token = context.attacker_token;
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
        attacker_token,
        user_receipt,
        DEPOSIT_AMOUNT,
    )
    .await;
    assert!(result.is_err(), "withdraw should not allow attacker-owned destination accounts");
}

#[tokio::test]
async fn attacker_cannot_pause_the_vault() {
    let mut context = setup().await.expect("setup succeeds");
    let attacker = clone_keypair(&context.attacker);
    let attacker_pubkey = attacker.pubkey();

    initialize_vault(&mut context)
        .await
        .expect("initialize succeeds");

    let result = set_paused_as(
        &mut context,
        attacker_pubkey,
        Some(&attacker),
        true,
    )
    .await;
    assert!(result.is_err(), "non-admin pause should fail");
}

#[tokio::test]
async fn deposit_rejects_wrong_mint_source_account() {
    let mut context = setup().await.expect("setup succeeds");
    let user = clone_keypair(&context.user);
    let user_pubkey = user.pubkey();
    let alternate_mint = context.alternate_mint.pubkey();
    let user_alternate_token = context.user_alternate_token;
    let user_receipt = context.user_receipt;

    initialize_vault(&mut context)
        .await
        .expect("initialize succeeds");

    let result = deposit(
        &mut context,
        user_pubkey,
        &user,
        alternate_mint,
        user_alternate_token,
        user_receipt,
        DEPOSIT_AMOUNT,
    )
    .await;
    assert!(result.is_err(), "wrong mint deposit should be rejected");
}
