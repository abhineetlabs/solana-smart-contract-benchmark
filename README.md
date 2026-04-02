# Solana Smart Contract Benchmark

Local benchmark harness for evaluating LLM performance on Solana smart contract generation tasks.

## Current Status

The repository is being built from the implementation blueprint in `docs/IMPLEMENTATION_BLUEPRINT.md`. The first milestone is:

- one real Anchor-flavored task
- mock baselines plus a Claude Code CLI adapter
- end-to-end benchmark runs with persisted artifacts and scores
- local self-check and warm-cache commands

## Quickstart

```bash
npm install --ignore-scripts
./benchmark validate
./benchmark list tasks
./benchmark list models
./benchmark warm-cache --track anchor --task counter_authority
./benchmark run --model mock/reference --track anchor --task counter_authority
./benchmark run --model claude-code/sonnet --track anchor --task counter_authority
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
- Claude Code runs depend on a local authenticated `claude` CLI session
