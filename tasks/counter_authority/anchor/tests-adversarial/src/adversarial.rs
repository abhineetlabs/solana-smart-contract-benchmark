use anchor_client::solana_sdk::signature::{Keypair, Signer};

use crate::common::{fetch_counter, increment_counter, initialize_counter, set_authority, setup};

#[test]
fn attacker_cannot_hijack_authority_transfer() {
    let (program, authority, counter, _) = setup();
    let attacker = Keypair::new();

    initialize_counter(&program, authority, &counter).expect("initialize succeeds");

    let result = set_authority(
        &program,
        attacker.pubkey(),
        Some(&attacker),
        counter.pubkey(),
        attacker.pubkey(),
    );

    assert!(result.is_err(), "attacker must not be able to take over authority");
}

#[test]
fn attacker_cannot_increment_even_when_funded() {
    let (program, authority, counter, attacker) = setup();

    initialize_counter(&program, authority, &counter).expect("initialize succeeds");

    let result = increment_counter(
        &program,
        attacker.pubkey(),
        Some(&attacker),
        counter.pubkey(),
    );
    assert!(result.is_err(), "non-authority increment should fail");
}

#[test]
fn authority_state_remains_consistent_after_valid_transfer() {
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
    .expect("new authority increments successfully");

    let state = fetch_counter(&program, counter.pubkey());
    assert_eq!(state.authority, next_authority.pubkey());
    assert_eq!(state.count, 1);
}
