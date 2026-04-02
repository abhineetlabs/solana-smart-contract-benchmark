# Solana Smart Contract Benchmark

Local benchmark harness for evaluating LLM performance on Solana smart contract generation tasks.

## Current Status

The repository is being built from the implementation blueprint in `docs/IMPLEMENTATION_BLUEPRINT.md`. The first milestone is:

- two working benchmark slices:
  - `counter_authority` on `anchor` and `native`
  - `escrow_basic` on `anchor`
- mock baselines plus a Claude Code CLI adapter
- end-to-end benchmark runs with persisted artifacts and scores
- local self-check, warm-cache, run-all, and compare commands

## Quickstart

```bash
npm install --ignore-scripts
./benchmark validate
./benchmark list tasks
./benchmark list models
./benchmark warm-cache --track anchor --task counter_authority
./benchmark run --model mock/reference --track anchor --task counter_authority
./benchmark warm-cache --track anchor --task escrow_basic
./benchmark baseline reference --track native --task counter_authority
./benchmark run --model claude-code/sonnet --track anchor --task counter_authority
./benchmark run-all --model claude-code/sonnet
./benchmark compare
./benchmark self-check
```

## Full Sweep

Run the whole currently supported benchmark matrix for a model:

```bash
./benchmark run-all --model claude-code/sonnet
```

Optional filters:

```bash
./benchmark run-all --model claude-code/sonnet --track anchor
./benchmark run-all --model claude-code/sonnet --task escrow_basic
./benchmark run-all --model claude-code/sonnet --warm-cache
```

Inspect the latest saved sweep report:

```bash
./benchmark compare
./benchmark compare --latest 2
./benchmark compare --model claude-code/sonnet
```

## What It Measures

- task completion behavior
- security-aware task structure
- framework-specific implementation fluency
- reproducible offline evaluation

## Current Limitations

- retrieval mode is not implemented yet
- there is not yet a richer leaderboard-style or HTML reporting layer
- only one native task is implemented so far
- Claude Code runs depend on a local authenticated `claude` CLI session
