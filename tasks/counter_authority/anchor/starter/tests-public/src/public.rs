use anchor_client::solana_sdk::signature::Signer;

use crate::common::{fetch_counter, increment_counter, initialize_counter, set_authority, setup};

#[test]
fn initializes_counter_with_authority_and_zero() {
    let (program, authority, counter, _) = setup();

    initialize_counter(&program, authority, &counter).expect("initialize succeeds");

    let state = fetch_counter(&program, counter.pubkey());
    assert_eq!(state.authority, authority);
    assert_eq!(state.count, 0);
}

#[test]
fn authority_can_increment_counter() {
    let (program, authority, counter, _) = setup();

    initialize_counter(&program, authority, &counter).expect("initialize succeeds");
    increment_counter(&program, authority, None, counter.pubkey()).expect("increment succeeds");

    let state = fetch_counter(&program, counter.pubkey());
    assert_eq!(state.count, 1);
}

#[test]
fn authority_can_transfer_authority() {
    let (program, authority, counter, next_authority) = setup();

    initialize_counter(&program, authority, &counter).expect("initialize succeeds");
    set_authority(
        &program,
        authority,
        None,
        counter.pubkey(),
        next_authority.pubkey(),
    )
    .expect("authority transfer succeeds");
    increment_counter(
        &program,
        next_authority.pubkey(),
        Some(&next_authority),
        counter.pubkey(),
    )
    .expect("new authority can increment");

    let state = fetch_counter(&program, counter.pubkey());
    assert_eq!(state.authority, next_authority.pubkey());
    assert_eq!(state.count, 1);
}
