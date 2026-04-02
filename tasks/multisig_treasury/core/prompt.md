Treat this as a production-style multisig treasury, not a toy vote counter.

Important expectations:

- the multisig state should be PDA-derived from the creator and a provided seed
- the treasury vault authority must be PDA-derived and must control the vault token account
- the owner set and threshold must be validated during initialization
- `propose_transfer` should create a proposal PDA and count the proposer as an approval
- `approve` must reject duplicate approvals and non-owner signers
- `execute` must validate both threshold and recipient binding before transferring treasury funds

The benchmark intentionally includes hidden and adversarial cases that try to:

- execute without enough approvals
- count the same approval twice
- approve or execute from a non-owner signer
- redirect payout to an attacker-owned token account with the correct mint
