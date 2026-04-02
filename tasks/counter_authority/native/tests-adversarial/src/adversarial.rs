use solana_sdk::signature::Signer;

use crate::common::{fetch_counter, increment_counter, initialize_counter, set_authority, setup};

#[tokio::test]
async fn attacker_cannot_hijack_authority_transfer() {
    let mut context = setup().await.expect("setup succeeds");
    let authority = context.context.payer.pubkey();
    let attacker = context.unauthorized.pubkey();
    let counter = context.counter.pubkey();

    initialize_counter(&mut context.context, counter, authority, None)
        .await
        .expect("initialize succeeds");

    let result = set_authority(
        &mut context.context,
        counter,
        attacker,
        Some(&context.unauthorized),
        attacker,
    )
    .await;
    assert!(result.is_err(), "attacker must not take over authority");
}

#[tokio::test]
async fn attacker_cannot_increment_even_after_legitimate_transfer() {
    let mut context = setup().await.expect("setup succeeds");
    let authority = context.context.payer.pubkey();
    let next_authority = context.next_authority.pubkey();
    let attacker = context.unauthorized.pubkey();
    let counter = context.counter.pubkey();

    initialize_counter(&mut context.context, counter, authority, None)
        .await
        .expect("initialize succeeds");
    set_authority(&mut context.context, counter, authority, None, next_authority)
        .await
        .expect("transfer succeeds");

    let result = increment_counter(
        &mut context.context,
        counter,
        attacker,
        Some(&context.unauthorized),
    )
    .await;
    assert!(result.is_err(), "attacker should still be rejected");
}

#[tokio::test]
async fn authority_state_remains_consistent_after_valid_transfer() {
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
    increment_counter(
        &mut context.context,
        counter,
        next_authority,
        Some(&context.next_authority),
    )
    .await
    .expect("new authority increments");

    let state = fetch_counter(&mut context.context, counter)
        .await
        .expect("fetch succeeds");
    assert_eq!(state.authority, next_authority);
    assert_eq!(state.count, 1);
}
