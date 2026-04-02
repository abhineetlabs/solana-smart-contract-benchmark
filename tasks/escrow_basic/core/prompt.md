Treat this as a production-style escrow, not just a happy-path demo.

Important expectations:

- the escrow account should be PDA-derived from the maker and a provided seed
- the vault authority should be PDA-derived and should be the authority over the vault token account
- `exchange` must validate that the maker, vault, payout accounts, and token mints all match the stored escrow state
- `cancel` must only allow the stored maker to recover funds
- both `exchange` and `cancel` should close temporary escrow resources after funds are returned

The benchmark intentionally includes hidden and adversarial cases that try to:

- redirect payout to attacker-controlled token accounts
- substitute the wrong mint while keeping the amounts plausible
- cancel from an unauthorized signer
- replay exchange after settlement
