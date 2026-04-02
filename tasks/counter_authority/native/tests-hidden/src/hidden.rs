use solana_sdk::signature::Signer;

use crate::common::{fetch_counter, increment_counter, initialize_counter, set_authority, setup};

#[tokio::test]
async fn unauthorized_signer_cannot_increment() {
    let mut context = setup().await.expect("setup succeeds");
    let authority = context.context.payer.pubkey();
    let unauthorized = context.unauthorized.pubkey();
    let counter = context.counter.pubkey();

    initialize_counter(&mut context.context, counter, authority, None)
        .await
        .expect("initialize succeeds");

    let result = increment_counter(
        &mut context.context,
        counter,
        unauthorized,
        Some(&context.unauthorized),
    )
    .await;
    assert!(result.is_err(), "unauthorized signer should be rejected");
}

#[tokio::test]
async fn unauthorized_signer_cannot_transfer_authority() {
    let mut context = setup().await.expect("setup succeeds");
    let authority = context.context.payer.pubkey();
    let unauthorized = context.unauthorized.pubkey();
    let counter = context.counter.pubkey();

    initialize_counter(&mut context.context, counter, authority, None)
        .await
        .expect("initialize succeeds");

    let result = set_authority(
        &mut context.context,
        counter,
        unauthorized,
        Some(&context.unauthorized),
        unauthorized,
    )
    .await;
    assert!(result.is_err(), "unauthorized transfer should fail");
}

#[tokio::test]
async fn previous_authority_loses_access_after_transfer() {
    let mut context = setup().await.expect("setup succeeds");
    let authority = context.context.payer.pubkey();
    let next_authority = context.next_authority.pubkey();
    let counter = context.counter.pubkey();

    initialize_counter(&mut context.context, counter, authority, None)
        .await
        .expect("initialize succeeds");
    set_authority(&mut context.context, counter, authority, None, next_authority)
        .await
        .expect("transfer succeeds");

    let result = increment_counter(&mut context.context, counter, authority, None).await;
    assert!(result.is_err(), "old authority should no longer increment");

    let state = fetch_counter(&mut context.context, counter)
        .await
        .expect("fetch succeeds");
    assert_eq!(state.authority, next_authority);
}
