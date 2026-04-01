# Adding a Model

Implement a new adapter in `packages/model-adapters/src/adapters/` and register it in the adapter registry.

All adapters must:

- accept the common request contract
- return raw model text and parsed file-map JSON when available
- avoid hidden retries unless they are explicitly logged
