use solana_sdk::signature::Signer;

use crate::common::{fetch_counter, increment_counter, initialize_counter, set_authority, setup};

#[tokio::test]
async fn initializes_counter_with_authority_and_zero() {
    let mut context = setup().await.expect("setup succeeds");
    let authority = context.context.payer.pubkey();
    let counter = context.counter.pubkey();

    initialize_counter(&mut context.context, counter, authority, None)
        .await
        .expect("initialize succeeds");

    let state = fetch_counter(&mut context.context, counter)
        .await
        .expect("fetch succeeds");
    assert_eq!(state.authority, authority);
    assert_eq!(state.count, 0);
}

#[tokio::test]
async fn authority_can_increment_counter() {
    let mut context = setup().await.expect("setup succeeds");
    let authority = context.context.payer.pubkey();
    let counter = context.counter.pubkey();

    initialize_counter(&mut context.context, counter, authority, None)
        .await
        .expect("initialize succeeds");
    increment_counter(&mut context.context, counter, authority, None)
        .await
        .expect("increment succeeds");

    let state = fetch_counter(&mut context.context, counter)
        .await
        .expect("fetch succeeds");
    assert_eq!(state.count, 1);
}

#[tokio::test]
async fn authority_can_transfer_authority() {
    let mut context = setup().await.expect("setup succeeds");
    let authority = context.context.payer.pubkey();
    let next_authority = context.next_authority.pubkey();
    let counter = context.counter.pubkey();

    initialize_counter(&mut context.context, counter, authority, None)
        .await
        .expect("initialize succeeds");
    set_authority(&mut context.context, counter, authority, None, next_authority)
        .await
        .expect("set_authority succeeds");
    increment_counter(
        &mut context.context,
        counter,
        next_authority,
        Some(&context.next_authority),
    )
    .await
    .expect("new authority increments successfully");

    let state = fetch_counter(&mut context.context, counter)
        .await
        .expect("fetch succeeds");
    assert_eq!(state.authority, next_authority);
    assert_eq!(state.count, 1);
}
