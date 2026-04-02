Treat this as a production-style vesting-router repair task, not a greenfield tutorial exercise.

Important expectations:

- the starter implementation is intentionally flawed but mostly complete; fix the vesting math and authorization checks instead of simplifying the design
- the stream config should be PDA-derived from the admin and a provided seed
- the router authority must be PDA-derived from the stream and must be the controller recorded in the helper vault
- `initialize_stream` must CPI into the helper guarded-vault program to create the custody vault
- `claim` must release only the newly vested delta, not the full vested amount every time
- `claim` must validate both the beneficiary signer and the ownership of the beneficiary payout token account

The benchmark intentionally includes hidden and adversarial cases that try to:

- claim multiple times across successive rounds and over-withdraw from the vault
- advance rounds from a non-admin signer
- claim from another beneficiary's stream
- redirect a valid beneficiary claim into an attacker-owned token account with the correct mint
