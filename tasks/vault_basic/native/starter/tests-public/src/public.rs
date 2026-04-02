use solana_sdk::signature::Signer;

use crate::common::{
    deposit_default, fetch_receipt, fetch_vault_config, initialize_vault, set_paused, setup,
    token_balance, withdraw_default, DEPOSIT_AMOUNT, INITIAL_USER_BALANCE, WITHDRAW_AMOUNT,
};

#[tokio::test]
async fn initialize_records_vault_state() {
    let mut context = setup().await.expect("setup succeeds");
    let mint = context.mint.pubkey();
    let vault = context.vault;

    initialize_vault(&mut context)
        .await
        .expect("initialize succeeds");

    let vault_config = fetch_vault_config(&mut context)
        .await
        .expect("vault config can be fetched");
    assert_eq!(vault_config.admin, context.admin);
    assert_eq!(vault_config.mint, mint);
    assert!(!vault_config.paused, "vault should start active");
    assert_eq!(vault_config.total_deposited, 0);
    assert_eq!(vault_config.total_withdrawn, 0);
    assert_eq!(
        token_balance(&mut context, vault)
            .await
            .expect("vault balance can be read"),
        0,
    );
}

#[tokio::test]
async fn deposit_and_withdraw_update_receipts_and_totals() {
    let mut context = setup().await.expect("setup succeeds");
    let user = context.user.pubkey();
    let user_receipt = context.user_receipt;
    let user_token = context.user_token;
    let vault = context.vault;

    initialize_vault(&mut context)
        .await
        .expect("initialize succeeds");
    deposit_default(&mut context)
        .await
        .expect("deposit succeeds");

    let receipt = fetch_receipt(&mut context, user_receipt)
        .await
        .expect("receipt can be fetched");
    assert_eq!(receipt.owner, user);
    assert_eq!(receipt.balance, DEPOSIT_AMOUNT);
    assert_eq!(
        token_balance(&mut context, user_token)
            .await
            .expect("user balance can be read"),
        INITIAL_USER_BALANCE - DEPOSIT_AMOUNT,
    );
    assert_eq!(
        token_balance(&mut context, vault)
            .await
            .expect("vault balance can be read"),
        DEPOSIT_AMOUNT,
    );

    withdraw_default(&mut context)
        .await
        .expect("withdraw succeeds");

    let updated_receipt = fetch_receipt(&mut context, user_receipt)
        .await
        .expect("updated receipt can be fetched");
    let vault_config = fetch_vault_config(&mut context)
        .await
        .expect("vault config can be fetched");
    assert_eq!(updated_receipt.balance, DEPOSIT_AMOUNT - WITHDRAW_AMOUNT);
    assert_eq!(vault_config.total_deposited, DEPOSIT_AMOUNT);
    assert_eq!(vault_config.total_withdrawn, WITHDRAW_AMOUNT);
    assert_eq!(
        token_balance(&mut context, user_token)
            .await
            .expect("user balance can be read"),
        INITIAL_USER_BALANCE - DEPOSIT_AMOUNT + WITHDRAW_AMOUNT,
    );
}

#[tokio::test]
async fn pause_blocks_movement_until_admin_resumes() {
    let mut context = setup().await.expect("setup succeeds");

    initialize_vault(&mut context)
        .await
        .expect("initialize succeeds");
    set_paused(&mut context, true).await.expect("pause succeeds");

    let paused_deposit = deposit_default(&mut context).await;
    assert!(paused_deposit.is_err(), "deposit should fail while paused");

    set_paused(&mut context, false)
        .await
        .expect("unpause succeeds");
    deposit_default(&mut context)
        .await
        .expect("deposit succeeds after unpause");

    set_paused(&mut context, true)
        .await
        .expect("pause succeeds again");
    let paused_withdraw = withdraw_default(&mut context).await;
    assert!(paused_withdraw.is_err(), "withdraw should fail while paused");
}
