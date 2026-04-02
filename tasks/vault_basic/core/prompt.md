Treat this as a production-style custody vault with user accounting, not a toy deposit demo.

Important expectations:

- the vault config should be PDA-derived from the admin and a provided seed
- the vault authority must be PDA-derived and must control the custody token account
- receipt PDAs should be derived from the vault and the depositing user
- `deposit` and `withdraw` must both enforce the configured mint and correct token-account ownership
- `withdraw` must only let a user redeem their own recorded balance
- `set_paused` must be admin-only, and both `deposit` and `withdraw` must respect the paused state

The benchmark intentionally includes hidden and adversarial cases that try to:

- withdraw from another user's receipt
- redirect withdrawals into attacker-controlled token accounts
- feed in the wrong mint while keeping the account layout plausible
- move funds while the admin has paused the vault
