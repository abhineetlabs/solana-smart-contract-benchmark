use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    account_exists, cancel_default, exchange_default, fetch_escrow, initialize_escrow, setup,
    token_balance, DESIRED_AMOUNT, MAKER_OFFERED_BALANCE, OFFERED_AMOUNT,
};

#[test]
fn initialize_locks_maker_tokens_and_records_state() {
    let context = setup().expect("setup succeeds");

    initialize_escrow(&context).expect("initialize succeeds");

    let escrow = fetch_escrow(&context).expect("escrow can be fetched");
    assert_eq!(escrow.maker, context.maker);
    assert_eq!(escrow.offered_mint, context.offered_mint.pubkey());
    assert_eq!(escrow.desired_mint, context.desired_mint.pubkey());
    assert_eq!(escrow.offered_amount, OFFERED_AMOUNT);
    assert_eq!(escrow.desired_amount, DESIRED_AMOUNT);
    assert_eq!(
        token_balance(&context, context.maker_offered_token).expect("maker balance can be read"),
        MAKER_OFFERED_BALANCE - OFFERED_AMOUNT,
    );
    assert_eq!(
        token_balance(&context, context.vault).expect("vault balance can be read"),
        OFFERED_AMOUNT,
    );
}

#[test]
fn exchange_moves_assets_and_closes_escrow() {
    let context = setup().expect("setup succeeds");

    initialize_escrow(&context).expect("initialize succeeds");
    exchange_default(&context).expect("exchange succeeds");

    assert_eq!(
        token_balance(&context, context.maker_desired_token).expect("maker desired balance is readable"),
        DESIRED_AMOUNT,
    );
    assert_eq!(
        token_balance(&context, context.taker_offered_token).expect("taker offered balance is readable"),
        OFFERED_AMOUNT,
    );
    assert!(!account_exists(&context, context.escrow), "escrow account should be closed");
    assert!(!account_exists(&context, context.vault), "vault account should be closed");
}

#[test]
fn maker_can_cancel_and_recover_deposit() {
    let context = setup().expect("setup succeeds");

    initialize_escrow(&context).expect("initialize succeeds");
    cancel_default(&context).expect("cancel succeeds");

    assert_eq!(
        token_balance(&context, context.maker_offered_token).expect("maker balance can be read"),
        MAKER_OFFERED_BALANCE,
    );
    assert!(!account_exists(&context, context.escrow), "escrow account should be closed");
    assert!(!account_exists(&context, context.vault), "vault account should be closed");
}
