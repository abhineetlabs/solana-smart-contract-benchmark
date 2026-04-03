use solana_sdk::signature::Signer;

use crate::common::{
    account_is_closed, cancel_default, exchange_default, fetch_escrow, initialize_escrow, setup,
    token_balance, DESIRED_AMOUNT, MAKER_OFFERED_BALANCE, OFFERED_AMOUNT,
};

#[tokio::test]
async fn initialize_locks_maker_tokens_and_records_state() {
    let mut context = setup().await.expect("setup succeeds");
    let maker_offered_token = context.maker_offered_token;
    let vault = context.vault;

    initialize_escrow(&mut context)
        .await
        .expect("initialize succeeds");

    let escrow = fetch_escrow(&mut context).await.expect("escrow can be fetched");
    assert_eq!(escrow.maker, context.maker);
    assert_eq!(escrow.offered_mint, context.offered_mint.pubkey());
    assert_eq!(escrow.desired_mint, context.desired_mint.pubkey());
    assert_eq!(escrow.offered_amount, OFFERED_AMOUNT);
    assert_eq!(escrow.desired_amount, DESIRED_AMOUNT);
    assert_eq!(
        token_balance(&mut context, maker_offered_token)
            .await
            .expect("maker balance can be read"),
        MAKER_OFFERED_BALANCE - OFFERED_AMOUNT,
    );
    assert_eq!(
        token_balance(&mut context, vault)
            .await
            .expect("vault balance can be read"),
        OFFERED_AMOUNT,
    );
}

#[tokio::test]
async fn exchange_moves_assets_and_closes_escrow() {
    let mut context = setup().await.expect("setup succeeds");
    let maker_desired_token = context.maker_desired_token;
    let taker_offered_token = context.taker_offered_token;
    let escrow = context.escrow;
    let vault = context.vault;

    initialize_escrow(&mut context)
        .await
        .expect("initialize succeeds");
    exchange_default(&mut context)
        .await
        .expect("exchange succeeds");

    assert_eq!(
        token_balance(&mut context, maker_desired_token)
            .await
            .expect("maker desired balance is readable"),
        DESIRED_AMOUNT,
    );
    assert_eq!(
        token_balance(&mut context, taker_offered_token)
            .await
            .expect("taker offered balance is readable"),
        OFFERED_AMOUNT,
    );
    assert!(
        account_is_closed(&mut context, escrow)
            .await
            .expect("escrow close state can be checked"),
        "escrow account should be closed",
    );
    assert!(
        account_is_closed(&mut context, vault)
            .await
            .expect("vault close state can be checked"),
        "vault account should be closed",
    );
}

#[tokio::test]
async fn maker_can_cancel_and_recover_deposit() {
    let mut context = setup().await.expect("setup succeeds");
    let maker_offered_token = context.maker_offered_token;
    let escrow = context.escrow;
    let vault = context.vault;

    initialize_escrow(&mut context)
        .await
        .expect("initialize succeeds");
    cancel_default(&mut context).await.expect("cancel succeeds");

    assert_eq!(
        token_balance(&mut context, maker_offered_token)
            .await
            .expect("maker balance can be read"),
        MAKER_OFFERED_BALANCE,
    );
    assert!(
        account_is_closed(&mut context, escrow)
            .await
            .expect("escrow close state can be checked"),
        "escrow account should be closed",
    );
    assert!(
        account_is_closed(&mut context, vault)
            .await
            .expect("vault close state can be checked"),
        "vault account should be closed",
    );
}
