use crate::common::{
    deposit, deposit_default, initialize_legacy_vault, migrate_receipt, migrate_receipt_default,
    migrate_vault, migrate_vault_as, setup, withdraw, DEPOSIT_AMOUNT,
};
use anchor_client::solana_sdk::signature::Signer;

#[test]
fn attacker_cannot_migrate_someone_elses_receipt() {
    let context = setup().expect("setup succeeds");

    initialize_legacy_vault(&context).expect("legacy initialize succeeds");
    deposit(
        &context,
        context.other_user.pubkey(),
        &context.other_user,
        context.mint.pubkey(),
        context.other_user_token,
        context.other_user_receipt,
        DEPOSIT_AMOUNT,
    )
    .expect("other user deposit succeeds");
    migrate_vault(&context).expect("vault migration succeeds");

    let result = migrate_receipt(
        &context,
        context.attacker.pubkey(),
        &context.attacker,
        context.other_user_receipt,
    );
    assert!(
        result.is_err(),
        "attacker should not be able to claim ownership of another user's legacy receipt during migration",
    );
}

#[test]
fn non_admin_cannot_migrate_legacy_vault() {
    let context = setup().expect("setup succeeds");

    initialize_legacy_vault(&context).expect("legacy initialize succeeds");

    let result = migrate_vault_as(
        &context,
        context.attacker.pubkey(),
        Some(&context.attacker),
    );
    assert!(result.is_err(), "non-admin vault migration should fail");
}

#[test]
fn migrated_withdraw_rejects_redirected_destination_account() {
    let context = setup().expect("setup succeeds");

    initialize_legacy_vault(&context).expect("legacy initialize succeeds");
    deposit_default(&context).expect("legacy deposit succeeds");
    migrate_vault(&context).expect("vault migration succeeds");
    migrate_receipt_default(&context).expect("receipt migration succeeds");

    let result = withdraw(
        &context,
        context.user.pubkey(),
        &context.user,
        context.mint.pubkey(),
        context.attacker_token,
        context.user_receipt,
        DEPOSIT_AMOUNT,
    );
    assert!(
        result.is_err(),
        "withdraw should not allow redirecting migrated funds into an attacker-owned token account",
    );
}
