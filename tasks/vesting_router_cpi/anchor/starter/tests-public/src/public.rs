use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    advance_round, claim_default, fetch_stream, fund_stream, initialize_stream, setup, token_balance,
    CLIFF_ROUND, FIRST_TRANCHE, TOTAL_AMOUNT, TOTAL_ROUNDS,
};

#[test]
fn initialize_records_stream_configuration() {
    let context = setup().expect("setup succeeds");

    initialize_stream(&context).expect("initialize succeeds");

    let stream = fetch_stream(&context).expect("stream can be fetched");
    assert_eq!(stream.admin, context.admin);
    assert_eq!(stream.beneficiary, context.beneficiary.pubkey());
    assert_eq!(stream.mint, context.mint.pubkey());
    assert_eq!(stream.total_amount, TOTAL_AMOUNT);
    assert_eq!(stream.cliff_round, CLIFF_ROUND);
    assert_eq!(stream.total_rounds, TOTAL_ROUNDS);
    assert_eq!(stream.current_round, 0);
    assert_eq!(stream.claimed_amount, 0);
    assert_eq!(
        token_balance(&context, context.vault_token).expect("vault balance can be read"),
        0,
    );
}

#[test]
fn beneficiary_claims_first_tranche_after_cliff() {
    let context = setup().expect("setup succeeds");

    initialize_stream(&context).expect("initialize succeeds");
    fund_stream(&context).expect("fund succeeds");
    advance_round(&context, CLIFF_ROUND).expect("advance succeeds");
    claim_default(&context).expect("claim succeeds");

    assert_eq!(
        token_balance(&context, context.beneficiary_token).expect("beneficiary balance can be read"),
        FIRST_TRANCHE,
    );
}

#[test]
fn beneficiary_claims_full_schedule_at_final_round() {
    let context = setup().expect("setup succeeds");

    initialize_stream(&context).expect("initialize succeeds");
    fund_stream(&context).expect("fund succeeds");
    advance_round(&context, TOTAL_ROUNDS).expect("advance succeeds");
    claim_default(&context).expect("claim succeeds");

    assert_eq!(
        token_balance(&context, context.beneficiary_token).expect("beneficiary balance can be read"),
        TOTAL_AMOUNT,
    );
}
