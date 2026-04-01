Implement the Anchor program logic in the editable file only.

Keep the account model simple and explicit:

- store the current authority pubkey in account state
- enforce signer-based authority checks in mutating instructions
- use checked arithmetic for the counter increment

Do not change the public test files.
