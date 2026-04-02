use crate::common::{
    deposit_default, fetch_receipt, fetch_vault_config, initialize_legacy_vault, initialize_vault,
    migrate_receipt_default, migrate_vault, set_paused, setup, token_balance, withdraw_default,
    CURRENT_VERSION, DEPOSIT_AMOUNT, INITIAL_USER_BALANCE, LEGACY_VERSION, WITHDRAW_AMOUNT,
};

#[test]
fn legacy_receipt_can_be_migrated_and_withdrawn() {
    let context = setup().expect("setup succeeds");

    initialize_legacy_vault(&context).expect("legacy initialize succeeds");
    deposit_default(&context).expect("legacy deposit succeeds");

    let legacy_receipt = fetch_receipt(&context, context.user_receipt).expect("legacy receipt can be fetched");
    assert_eq!(legacy_receipt.version, LEGACY_VERSION);

    migrate_vault(&context).expect("vault migration succeeds");
    migrate_receipt_default(&context).expect("receipt migration succeeds");
    withdraw_default(&context).expect("withdraw succeeds after migration");

    let receipt = fetch_receipt(&context, context.user_receipt).expect("receipt can be fetched");
    let vault_config = fetch_vault_config(&context).expect("vault config can be fetched");
    assert_eq!(receipt.version, CURRENT_VERSION);
    assert_eq!(receipt.balance, DEPOSIT_AMOUNT - WITHDRAW_AMOUNT);
    assert_eq!(receipt.withdrawn_total, WITHDRAW_AMOUNT);
    assert_eq!(vault_config.version, CURRENT_VERSION);
    assert_eq!(vault_config.total_deposited, DEPOSIT_AMOUNT);
    assert_eq!(vault_config.total_withdrawn, WITHDRAW_AMOUNT);
}

#[test]
fn current_vault_creates_current_receipts() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("current initialize succeeds");
    deposit_default(&context).expect("deposit succeeds");

    let receipt = fetch_receipt(&context, context.user_receipt).expect("receipt can be fetched");
    let vault_config = fetch_vault_config(&context).expect("vault config can be fetched");
    assert_eq!(vault_config.version, CURRENT_VERSION);
    assert_eq!(receipt.version, CURRENT_VERSION);
    assert_eq!(receipt.balance, DEPOSIT_AMOUNT);
    assert_eq!(
        token_balance(&context, context.user_token).expect("user balance can be read"),
        INITIAL_USER_BALANCE - DEPOSIT_AMOUNT,
    );
}

#[test]
fn migrated_vault_can_pause_and_resume_movement() {
    let context = setup().expect("setup succeeds");

    initialize_legacy_vault(&context).expect("legacy initialize succeeds");
    deposit_default(&context).expect("legacy deposit succeeds");
    migrate_vault(&context).expect("vault migration succeeds");
    migrate_receipt_default(&context).expect("receipt migration succeeds");

    set_paused(&context, true).expect("pause succeeds");
    let paused_withdraw = withdraw_default(&context);
    assert!(paused_withdraw.is_err(), "withdraw should fail while paused");

    set_paused(&context, false).expect("unpause succeeds");
    withdraw_default(&context).expect("withdraw succeeds after unpause");
}
