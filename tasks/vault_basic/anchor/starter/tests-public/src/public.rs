use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    deposit_default, fetch_receipt, fetch_vault_config, initialize_vault, set_paused, setup,
    token_balance, withdraw_default, DEPOSIT_AMOUNT, INITIAL_USER_BALANCE, WITHDRAW_AMOUNT,
};

#[test]
fn initialize_records_vault_state() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("initialize succeeds");

    let vault_config = fetch_vault_config(&context).expect("vault config can be fetched");
    assert_eq!(vault_config.admin, context.admin);
    assert_eq!(vault_config.mint, context.mint.pubkey());
    assert!(!vault_config.paused, "vault should start active");
    assert_eq!(vault_config.total_deposited, 0);
    assert_eq!(vault_config.total_withdrawn, 0);
    assert_eq!(
        token_balance(&context, context.vault).expect("vault balance can be read"),
        0,
    );
}

#[test]
fn deposit_and_withdraw_update_receipts_and_totals() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("initialize succeeds");
    deposit_default(&context).expect("deposit succeeds");

    let receipt = fetch_receipt(&context, context.user_receipt).expect("receipt can be fetched");
    assert_eq!(receipt.owner, context.user.pubkey());
    assert_eq!(receipt.balance, DEPOSIT_AMOUNT);
    assert_eq!(
        token_balance(&context, context.user_token).expect("user balance can be read"),
        INITIAL_USER_BALANCE - DEPOSIT_AMOUNT,
    );
    assert_eq!(
        token_balance(&context, context.vault).expect("vault balance can be read"),
        DEPOSIT_AMOUNT,
    );

    withdraw_default(&context).expect("withdraw succeeds");

    let updated_receipt =
        fetch_receipt(&context, context.user_receipt).expect("updated receipt can be fetched");
    let vault_config = fetch_vault_config(&context).expect("vault config can be fetched");
    assert_eq!(updated_receipt.balance, DEPOSIT_AMOUNT - WITHDRAW_AMOUNT);
    assert_eq!(vault_config.total_deposited, DEPOSIT_AMOUNT);
    assert_eq!(vault_config.total_withdrawn, WITHDRAW_AMOUNT);
    assert_eq!(
        token_balance(&context, context.user_token).expect("user balance can be read"),
        INITIAL_USER_BALANCE - DEPOSIT_AMOUNT + WITHDRAW_AMOUNT,
    );
}

#[test]
fn pause_blocks_movement_until_admin_resumes() {
    let context = setup().expect("setup succeeds");

    initialize_vault(&context).expect("initialize succeeds");
    set_paused(&context, true).expect("pause succeeds");

    let paused_deposit = deposit_default(&context);
    assert!(paused_deposit.is_err(), "deposit should fail while paused");

    set_paused(&context, false).expect("unpause succeeds");
    deposit_default(&context).expect("deposit succeeds after unpause");

    set_paused(&context, true).expect("pause succeeds again");
    let paused_withdraw = withdraw_default(&context);
    assert!(paused_withdraw.is_err(), "withdraw should fail while paused");
}
