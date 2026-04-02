Treat this as a production upgrade task, not a greenfield tutorial exercise.

Important expectations:

- the starter implementation is intentionally flawed but mostly complete; fix the migration logic and validation instead of redesigning the protocol
- V1 vault configs and receipts already exist, so migration must preserve balances, ownership, PDA authority, and accounting totals
- `migrate_vault` must be admin-only and safe to call repeatedly without resetting state
- `migrate_receipt` must preserve the stored owner and withdrawal history instead of rebinding the receipt to the current signer
- V2 withdrawals must require migrated receipts and must validate the destination token account owner and mint

The benchmark intentionally includes hidden and adversarial cases that try to:

- call vault or receipt migration multiple times after withdrawals have already occurred
- withdraw from a legacy receipt after the vault has already been upgraded
- migrate another user's legacy receipt with an attacker signer
- migrate a vault from a non-admin signer
- redirect a valid migrated withdrawal into an attacker-owned token account
