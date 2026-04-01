# Solana Smart Contract Benchmark

Local benchmark harness for evaluating LLM performance on Solana smart contract generation tasks.

## Current Status

The repository is being built from the implementation blueprint in `docs/IMPLEMENTATION_BLUEPRINT.md`. The first milestone is:

- one Anchor-flavored task
- one mock model adapter
- one end-to-end benchmark run
- artifact and result persistence

## Quickstart

```bash
npm install --ignore-scripts
./benchmark validate
./benchmark list tasks
./benchmark list models
./benchmark run --model mock/reference --track anchor --task counter_authority
./benchmark self-check
```

## What It Measures

- task completion behavior
- security-aware task structure
- framework-specific implementation fluency
- reproducible offline evaluation

## Current Limitations

- retrieval mode is not implemented yet
- only the first Anchor task is implemented so far
- Native track and additional tasks are still pending
- the first real Anchor run may need to fetch Rust test dependencies into the shared Cargo cache
