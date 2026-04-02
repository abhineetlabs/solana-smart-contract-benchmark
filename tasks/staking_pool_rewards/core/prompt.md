Treat this as a production-style DeFi staking pool repair task, not a greenfield tutorial exercise.

Important expectations:

- the starter implementation is intentionally flawed but mostly complete; fix the reward accounting and authority checks instead of simplifying the design
- the pool config should be PDA-derived from the admin and a provided seed
- the pool authority must be PDA-derived and must control both the stake vault and the reward vault
- `stake` and `unstake` must preserve already-accrued rewards when a position's amount changes
- `deposit_rewards` must only distribute rewards when the pool actually has active stakers
- `claim` and `unstake` must validate that the signer really owns the position they are operating on

The benchmark intentionally includes hidden and adversarial cases that try to:

- add stake after one reward epoch and then claim after a later epoch
- partially unstake after rewards have accrued and then claim
- call reward distribution when there are zero stakers
- claim or unstake from another user's position via account substitution
