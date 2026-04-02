use anchor_client::solana_sdk::signature::Signer;

use crate::common::{
    claim_for, deposit_rewards, initialize_pool, setup, stake_default, unstake_for, FIRST_REWARD_AMOUNT,
};

#[test]
fn attacker_cannot_claim_another_users_position() {
    let context = setup().expect("setup succeeds");

    initialize_pool(&context).expect("initialize succeeds");
    stake_default(&context).expect("stake succeeds");
    deposit_rewards(&context, FIRST_REWARD_AMOUNT).expect("reward deposit succeeds");

    assert!(
        claim_for(
            &context,
            context.attacker.pubkey(),
            &context.attacker,
            context.attacker_reward_token,
            context.user_position,
        )
        .is_err(),
        "attacker should not be able to claim another user's rewards"
    );
}

#[test]
fn attacker_cannot_unstake_another_users_position() {
    let context = setup().expect("setup succeeds");

    initialize_pool(&context).expect("initialize succeeds");
    stake_default(&context).expect("stake succeeds");

    assert!(
        unstake_for(
            &context,
            context.attacker.pubkey(),
            &context.attacker,
            context.attacker_stake_token,
            context.user_position,
            50,
        )
        .is_err(),
        "attacker should not be able to unstake another user's funds"
    );
}
