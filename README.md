# Solana Smart Contract Benchmark

Local benchmark harness for evaluating LLM performance on Solana smart contract generation tasks.

## Current Status

The repository is being built from the implementation blueprint in [docs/IMPLEMENTATION_BLUEPRINT.md](/Users/abhineet/DEV/Build/Solana Smart Contract Benchmark/docs/IMPLEMENTATION_BLUEPRINT.md). The first milestone is:

- one Anchor-flavored task
- one mock model adapter
- one end-to-end benchmark run
- artifact and result persistence

## Quickstart

```bash
npm install
./benchmark validate
./benchmark list tasks
./benchmark list models
./benchmark run --model mock/reference --track anchor --task counter_authority
```

## What It Measures

- task completion behavior
- security-aware task structure
- framework-specific implementation fluency
- reproducible offline evaluation

## Current Limitations

- retrieval mode is not implemented yet
- hidden and adversarial test execution is still being added
- the initial task fixture is a harness bootstrap task, not a full Solana toolchain-backed benchmark
