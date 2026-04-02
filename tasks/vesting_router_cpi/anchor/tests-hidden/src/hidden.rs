use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    advance_round, advance_round_as, claim_default, claim_with_accounts, fund_stream, initialize_stream,
    setup, token_balance, CLIFF_ROUND, SECOND_TRANCHE_TOTAL,
};

#[test]
fn repeated_claims_only_receive_newly_vested_delta() {
    let context = setup().expect("setup succeeds");

    initialize_stream(&context).expect("initialize succeeds");
    fund_stream(&context).expect("fund succeeds");
    advance_round(&context, CLIFF_ROUND).expect("first advance succeeds");
    claim_default(&context).expect("first claim succeeds");
    advance_round(&context, CLIFF_ROUND + 1).expect("second advance succeeds");
    claim_default(&context).expect("second claim succeeds");

    assert_eq!(
        token_balance(&context, context.beneficiary_token).expect("beneficiary balance can be read"),
        SECOND_TRANCHE_TOTAL,
    );
}

#[test]
fn non_admin_cannot_advance_rounds() {
    let context = setup().expect("setup succeeds");

    initialize_stream(&context).expect("initialize succeeds");
    assert!(
        advance_round_as(&context, context.attacker.pubkey(), Some(&context.attacker), CLIFF_ROUND).is_err(),
        "non-admin should not be able to advance rounds"
    );
}

#[test]
fn only_configured_beneficiary_can_claim() {
    let context = setup().expect("setup succeeds");

    initialize_stream(&context).expect("initialize succeeds");
    fund_stream(&context).expect("fund succeeds");
    advance_round(&context, CLIFF_ROUND).expect("advance succeeds");

    assert!(
        claim_with_accounts(
            &context,
            context.attacker.pubkey(),
            &context.attacker,
            context.attacker_token,
            context.vault,
            context.vault_authority,
            context.vault_token,
        )
        .is_err(),
        "beneficiary binding should be enforced"
    );
}
