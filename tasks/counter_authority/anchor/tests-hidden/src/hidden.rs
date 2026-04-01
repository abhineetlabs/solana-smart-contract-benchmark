use anchor_client::solana_sdk::signature::Signer;

use crate::common::{increment_counter, initialize_counter, set_authority, setup};

#[test]
fn unauthorized_signer_cannot_increment() {
    let (program, authority, counter, unauthorized) = setup();

    initialize_counter(&program, authority, &counter).expect("initialize succeeds");

    let result = increment_counter(
        &program,
        unauthorized.pubkey(),
        Some(&unauthorized),
        counter.pubkey(),
    );
    assert!(result.is_err(), "unauthorized signer should be rejected");
}

#[test]
fn unauthorized_signer_cannot_transfer_authority() {
    let (program, authority, counter, unauthorized) = setup();

    initialize_counter(&program, authority, &counter).expect("initialize succeeds");

    let result = set_authority(
        &program,
        unauthorized.pubkey(),
        Some(&unauthorized),
        counter.pubkey(),
        unauthorized.pubkey(),
    );
    assert!(result.is_err(), "unauthorized authority transfer should fail");
}

#[test]
fn previous_authority_loses_access_after_transfer() {
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

    let result = increment_counter(&program, authority, None, counter.pubkey());
    assert!(result.is_err(), "old authority should no longer be able to increment");
}
