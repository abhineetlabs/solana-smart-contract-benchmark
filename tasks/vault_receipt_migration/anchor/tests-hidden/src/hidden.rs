use crate::common::{
    deposit_default, fetch_receipt, fetch_vault_config, initialize_legacy_vault, migrate_receipt,
    migrate_receipt_default, migrate_vault, setup, withdraw, DEPOSIT_AMOUNT, WITHDRAW_AMOUNT,
};
use anchor_client::solana_sdk::signature::Signer;

#[test]
fn repeated_vault_migration_is_idempotent_for_totals() {
    let context = setup().expect("setup succeeds");

    initialize_legacy_vault(&context).expect("legacy initialize succeeds");
    deposit_default(&context).expect("legacy deposit succeeds");
    migrate_vault(&context).expect("first vault migration succeeds");
    migrate_receipt_default(&context).expect("receipt migration succeeds");
    withdraw(
        &context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.user_token,
        context.user_receipt,
        WITHDRAW_AMOUNT,
    )
    .expect("withdraw succeeds");

    migrate_vault(&context).expect("second vault migration succeeds");

    let vault_config = fetch_vault_config(&context).expect("vault config can be fetched");
    assert_eq!(
        vault_config.total_withdrawn,
        WITHDRAW_AMOUNT,
        "repeat vault migration must not reset withdrawal history",
    );
}

#[test]
fn repeated_receipt_migration_preserves_owner_and_withdrawn_total() {
    let context = setup().expect("setup succeeds");

    initialize_legacy_vault(&context).expect("legacy initialize succeeds");
    deposit_default(&context).expect("legacy deposit succeeds");
    migrate_vault(&context).expect("vault migration succeeds");
    migrate_receipt_default(&context).expect("first receipt migration succeeds");
    withdraw(
        &context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.user_token,
        context.user_receipt,
        WITHDRAW_AMOUNT,
    )
    .expect("withdraw succeeds");

    migrate_receipt(
        &context,
        context.user.pubkey(),
        &context.user,
        context.user_receipt,
    )
    .expect("second receipt migration succeeds");

    let receipt = fetch_receipt(&context, context.user_receipt).expect("receipt can be fetched");
    assert_eq!(receipt.owner, context.user.pubkey());
    assert_eq!(
        receipt.withdrawn_total,
        WITHDRAW_AMOUNT,
        "repeat receipt migration must preserve withdrawal history",
    );
    assert_eq!(receipt.balance, DEPOSIT_AMOUNT - WITHDRAW_AMOUNT);
}

#[test]
fn migrated_vault_requires_receipt_upgrade_before_withdrawal() {
    let context = setup().expect("setup succeeds");

    initialize_legacy_vault(&context).expect("legacy initialize succeeds");
    deposit_default(&context).expect("legacy deposit succeeds");
    migrate_vault(&context).expect("vault migration succeeds");

    let result = withdraw(
        &context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.user_token,
        context.user_receipt,
        WITHDRAW_AMOUNT,
    );
    assert!(
        result.is_err(),
        "withdrawing from a legacy receipt after vault migration should require an explicit receipt migration",
    );
}
