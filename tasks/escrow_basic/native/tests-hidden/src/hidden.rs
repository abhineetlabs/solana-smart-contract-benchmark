use solana_sdk::signature::Signer;

use crate::common::{
    cancel, exchange, initialize_escrow, initialize_with_amounts, setup, DESIRED_AMOUNT,
    OFFERED_AMOUNT,
};

#[tokio::test]
async fn initialize_rejects_zero_amounts() {
    let mut context = setup().await.expect("setup succeeds");

    let zero_offered = initialize_with_amounts(&mut context, 0, DESIRED_AMOUNT).await;
    assert!(zero_offered.is_err(), "zero offered amount should be rejected");

    let zero_desired = initialize_with_amounts(&mut context, OFFERED_AMOUNT, 0).await;
    assert!(zero_desired.is_err(), "zero desired amount should be rejected");
}

#[tokio::test]
async fn attacker_cannot_cancel_to_their_own_token_account() {
    let mut context = setup().await.expect("setup succeeds");
    let attacker = crate::common::clone_keypair(&context.attacker);
    let attacker_offered_token = context.attacker_offered_token;

    initialize_escrow(&mut context)
        .await
        .expect("initialize succeeds");

    let result = cancel(
        &mut context,
        attacker.pubkey(),
        Some(&attacker),
        attacker_offered_token,
    )
    .await;
    assert!(result.is_err(), "unauthorized cancel should fail");
}

#[tokio::test]
async fn exchange_rejects_wrong_requested_mint() {
    let mut context = setup().await.expect("setup succeeds");
    let taker = crate::common::clone_keypair(&context.taker);
    let maker = context.maker;
    let maker_alternate_token = context.maker_alternate_token;
    let taker_alternate_token = context.taker_alternate_token;
    let taker_offered_token = context.taker_offered_token;
    let alternate_mint = context.alternate_mint.pubkey();

    initialize_escrow(&mut context)
        .await
        .expect("initialize succeeds");

    let result = exchange(
        &mut context,
        maker,
        maker_alternate_token,
        taker.pubkey(),
        Some(&taker),
        taker_alternate_token,
        taker_offered_token,
        alternate_mint,
    )
    .await;
    assert!(result.is_err(), "wrong desired mint should be rejected");
}
