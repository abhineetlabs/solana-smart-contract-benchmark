use solana_sdk::signature::Signer;

use crate::common::{exchange, exchange_default, initialize_escrow, setup};

#[tokio::test]
async fn exchange_rejects_fake_maker_account() {
    let mut context = setup().await.expect("setup succeeds");
    let taker = crate::common::clone_keypair(&context.taker);
    let attacker = crate::common::clone_keypair(&context.attacker);
    let attacker_desired_token = context.attacker_desired_token;
    let taker_desired_token = context.taker_desired_token;
    let taker_offered_token = context.taker_offered_token;
    let desired_mint = context.desired_mint.pubkey();

    initialize_escrow(&mut context)
        .await
        .expect("initialize succeeds");

    let result = exchange(
        &mut context,
        attacker.pubkey(),
        attacker_desired_token,
        taker.pubkey(),
        Some(&taker),
        taker_desired_token,
        taker_offered_token,
        desired_mint,
    )
    .await;
    assert!(result.is_err(), "fake maker should not receive payout");
}

#[tokio::test]
async fn exchange_rejects_redirected_payout_account() {
    let mut context = setup().await.expect("setup succeeds");
    let taker = crate::common::clone_keypair(&context.taker);
    let maker = context.maker;
    let attacker_desired_token = context.attacker_desired_token;
    let taker_desired_token = context.taker_desired_token;
    let taker_offered_token = context.taker_offered_token;
    let desired_mint = context.desired_mint.pubkey();

    initialize_escrow(&mut context)
        .await
        .expect("initialize succeeds");

    let result = exchange(
        &mut context,
        maker,
        attacker_desired_token,
        taker.pubkey(),
        Some(&taker),
        taker_desired_token,
        taker_offered_token,
        desired_mint,
    )
    .await;
    assert!(
        result.is_err(),
        "attacker-controlled payout account should be rejected",
    );
}

#[tokio::test]
async fn exchange_cannot_be_replayed_after_success() {
    let mut context = setup().await.expect("setup succeeds");

    initialize_escrow(&mut context)
        .await
        .expect("initialize succeeds");
    exchange_default(&mut context)
        .await
        .expect("first exchange succeeds");

    let replay = exchange_default(&mut context).await;
    assert!(replay.is_err(), "escrow should not be reusable after settlement");
}
