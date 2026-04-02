use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    claim_for, deposit_rewards, initialize_pool, setup, stake_default, stake_for, token_balance,
    unstake_for, DEFAULT_STAKE_AMOUNT, FIRST_REWARD_AMOUNT, SECOND_REWARD_AMOUNT,
};

#[test]
fn staking_more_after_rewards_preserves_previous_accrual() {
    let context = setup().expect("setup succeeds");

    initialize_pool(&context).expect("initialize succeeds");
    stake_default(&context).expect("first stake succeeds");
    deposit_rewards(&context, 40).expect("first reward deposit succeeds");
    stake_for(
        &context,
        context.user.pubkey(),
        &context.user,
        context.user_stake_token,
        context.user_position,
        DEFAULT_STAKE_AMOUNT,
    )
    .expect("second stake succeeds");
    deposit_rewards(&context, SECOND_REWARD_AMOUNT).expect("second reward deposit succeeds");
    claim_for(
        &context,
        context.user.pubkey(),
        &context.user,
        context.user_reward_token,
        context.user_position,
    )
    .expect("claim succeeds");

    assert_eq!(
        token_balance(&context, context.user_reward_token).expect("reward balance can be read"),
        100,
    );
}

#[test]
fn partial_unstake_preserves_accrued_rewards() {
    let context = setup().expect("setup succeeds");

    initialize_pool(&context).expect("initialize succeeds");
    stake_for(
        &context,
        context.user.pubkey(),
        &context.user,
        context.user_stake_token,
        context.user_position,
        200,
    )
    .expect("stake succeeds");
    deposit_rewards(&context, 100).expect("first reward deposit succeeds");
    unstake_for(
        &context,
        context.user.pubkey(),
        &context.user,
        context.user_stake_token,
        context.user_position,
        100,
    )
    .expect("unstake succeeds");
    deposit_rewards(&context, 50).expect("second reward deposit succeeds");
    claim_for(
        &context,
        context.user.pubkey(),
        &context.user,
        context.user_reward_token,
        context.user_position,
    )
    .expect("claim succeeds");

    assert_eq!(
        token_balance(&context, context.user_reward_token).expect("reward balance can be read"),
        150,
    );
}

#[test]
fn reward_deposits_require_active_stakers() {
    let context = setup().expect("setup succeeds");

    initialize_pool(&context).expect("initialize succeeds");
    assert!(
        deposit_rewards(&context, FIRST_REWARD_AMOUNT).is_err(),
        "reward deposit should fail when nobody is staked"
    );
}
