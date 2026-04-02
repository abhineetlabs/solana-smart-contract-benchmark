use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    advance_round, claim_with_accounts, direct_fund_vault, fund_stream, initialize_alternate_vault,
    initialize_stream, setup, ALT_VAULT_SEED, CLIFF_ROUND, FIRST_TRANCHE,
};

#[test]
fn beneficiary_cannot_redirect_claim_to_attacker_token() {
    let context = setup().expect("setup succeeds");

    initialize_stream(&context).expect("initialize succeeds");
    fund_stream(&context).expect("fund succeeds");
    advance_round(&context, CLIFF_ROUND).expect("advance succeeds");

    assert!(
        claim_with_accounts(
            &context,
            context.beneficiary.pubkey(),
            &context.beneficiary,
            context.attacker_token,
            context.vault,
            context.vault_authority,
            context.vault_token,
        )
        .is_err(),
        "recipient token ownership should be enforced"
    );
}

#[test]
fn claim_cannot_substitute_alternate_helper_vault() {
    let context = setup().expect("setup succeeds");

    initialize_stream(&context).expect("initialize succeeds");
    let (alt_vault, alt_vault_authority, alt_vault_token) =
        initialize_alternate_vault(&context, ALT_VAULT_SEED).expect("alternate vault initializes");
    direct_fund_vault(&context, alt_vault_token, FIRST_TRANCHE).expect("alternate vault funding succeeds");
    advance_round(&context, CLIFF_ROUND).expect("advance succeeds");

    assert!(
        claim_with_accounts(
            &context,
            context.beneficiary.pubkey(),
            &context.beneficiary,
            context.beneficiary_token,
            alt_vault,
            alt_vault_authority,
            alt_vault_token,
        )
        .is_err(),
        "stream should stay bound to its original helper vault"
    );
}
