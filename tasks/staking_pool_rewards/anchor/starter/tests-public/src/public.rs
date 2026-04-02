use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    claim_for, deposit_rewards, fetch_pool, initialize_pool, setup, stake_default, stake_second_user,
    token_balance, FIRST_REWARD_AMOUNT,
};

#[test]
fn initialize_records_pool_configuration() {
    let context = setup().expect("setup succeeds");

    initialize_pool(&context).expect("initialize succeeds");

    let pool = fetch_pool(&context).expect("pool can be fetched");
    assert_eq!(pool.admin, context.admin);
    assert_eq!(pool.stake_mint, context.stake_mint.pubkey());
    assert_eq!(pool.reward_mint, context.reward_mint.pubkey());
    assert_eq!(pool.total_staked, 0);
    assert_eq!(pool.acc_reward_per_share, 0);
    assert_eq!(
        token_balance(&context, context.stake_vault).expect("stake vault balance can be read"),
        0,
    );
    assert_eq!(
        token_balance(&context, context.reward_vault).expect("reward vault balance can be read"),
        0,
    );
}

#[test]
fn single_staker_claims_full_reward_epoch() {
    let context = setup().expect("setup succeeds");

    initialize_pool(&context).expect("initialize succeeds");
    stake_default(&context).expect("stake succeeds");
    deposit_rewards(&context, FIRST_REWARD_AMOUNT).expect("reward deposit succeeds");
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
        FIRST_REWARD_AMOUNT,
    );
}

#[test]
fn two_stakers_split_single_epoch_by_weight() {
    let context = setup().expect("setup succeeds");

    initialize_pool(&context).expect("initialize succeeds");
    stake_default(&context).expect("user stake succeeds");
    stake_second_user(&context).expect("second stake succeeds");
    deposit_rewards(&context, FIRST_REWARD_AMOUNT).expect("reward deposit succeeds");

    claim_for(
        &context,
        context.user.pubkey(),
        &context.user,
        context.user_reward_token,
        context.user_position,
    )
    .expect("first claim succeeds");
    claim_for(
        &context,
        context.second_user.pubkey(),
        &context.second_user,
        context.second_user_reward_token,
        context.second_user_position,
    )
    .expect("second claim succeeds");

    assert_eq!(
        token_balance(&context, context.user_reward_token).expect("first reward balance can be read"),
        20,
    );
    assert_eq!(
        token_balance(&context, context.second_user_reward_token)
            .expect("second reward balance can be read"),
        60,
    );
}
