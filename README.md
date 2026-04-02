# Solana Smart Contract Benchmark

Local benchmark harness for evaluating LLM performance on Solana smart contract generation and repair tasks.

## Current Status

The repository is being built from the implementation blueprint in `docs/IMPLEMENTATION_BLUEPRINT.md`. The current benchmark now includes:

- eight working benchmark pairs:
  - `counter_authority` on `anchor` and `native`
  - `escrow_basic` on `anchor`
  - `vault_basic` on `anchor` and `native`
  - `multisig_treasury` on `anchor`
  - `staking_pool_rewards` on `anchor`
  - `vesting_router_cpi` on `anchor`
- a more demanding task mix focused on PDA custody, per-user accounting, threshold-controlled treasury execution, repair-style reward-accounting bugs, and multi-program CPI claim flows
- a frozen `ranking_v1` suite for repeatable model-vs-model comparisons
- mock baselines plus Claude Code, Codex CLI, and OpenCode adapters
- end-to-end benchmark runs with persisted artifacts and scores
- local self-check, warm-cache, run-all, compare, and suite commands

## Quickstart

```bash
npm install --ignore-scripts
./benchmark validate
./benchmark list tasks
./benchmark list models
./benchmark list suites
./benchmark warm-cache --track anchor --task counter_authority
./benchmark run --model mock/reference --track anchor --task counter_authority
./benchmark warm-cache --track anchor --task escrow_basic
./benchmark warm-cache --track anchor --task vault_basic
./benchmark warm-cache --track native --task vault_basic
./benchmark warm-cache --track anchor --task multisig_treasury
./benchmark warm-cache --track anchor --task staking_pool_rewards
./benchmark warm-cache --track anchor --task vesting_router_cpi
./benchmark baseline reference --track native --task counter_authority
./benchmark baseline reference --track native --task vault_basic
./benchmark baseline reference --track anchor --task staking_pool_rewards
./benchmark baseline reference --track anchor --task vesting_router_cpi
./benchmark run --model mock/starter --track anchor --task staking_pool_rewards
./benchmark run --model mock/starter --track anchor --task vesting_router_cpi
./benchmark run --model claude-code/sonnet --track anchor --task counter_authority
./benchmark run --model codex/default --track anchor --task counter_authority
./benchmark run --model opencode/default --track anchor --task counter_authority
./benchmark run-all --model claude-code/sonnet --suite ranking_v1
./benchmark run-all --model mock/reference --track native --difficulty hard --repeats 2
./benchmark compare
./benchmark compare --suite ranking_v1
./benchmark self-check --suite ranking_v1
```

## Model Adapters

Built-in model ids currently listed by the CLI:

- `mock/reference`
- `mock/insecure`
- `mock/invalid-json`
- `mock/starter`
- `claude-code/default`
- `claude-code/sonnet`
- `claude-code/opus`
- `codex/default`
- `codex-oss/ollama/default`
- `codex-oss/lmstudio/default`
- `opencode/default`

The Codex adapter also accepts explicit model patterns even when they are not listed verbatim:

- `codex/<model>`
- `codex-oss/ollama/<model>`
- `codex-oss/lmstudio/<model>`

Examples:

```bash
./benchmark run --model codex/default --track anchor --task counter_authority
./benchmark run --model codex/gpt-5 --track anchor --task vesting_router_cpi
./benchmark run --model codex-oss/ollama/qwen2.5-coder:32b --track anchor --task escrow_basic
```

The OpenCode adapter accepts:

- `opencode/default`
- `opencode/<provider>/<model>`

Examples:

```bash
./benchmark run --model opencode/default --track anchor --task counter_authority
./benchmark run --model opencode/openrouter/qwen/qwen3-coder --track anchor --task escrow_basic
./benchmark run --model opencode/ollama/qwen2.5-coder:32b --track anchor --task vesting_router_cpi
```

## Full Sweep

Run the whole currently supported benchmark matrix for a model:

```bash
./benchmark run-all --model claude-code/sonnet
./benchmark run-all --model claude-code/sonnet --difficulty hard
```

Run the frozen ranking suite instead of the whole evolving task matrix:

```bash
./benchmark list suites
./benchmark run-all --model claude-code/sonnet --suite ranking_v1
./benchmark run-all --model codex/default --suite ranking_v1
./benchmark compare --suite ranking_v1
```

Optional filters:

```bash
./benchmark run-all --model claude-code/sonnet --difficulty hard
./benchmark run-all --model claude-code/sonnet --track anchor
./benchmark run-all --model claude-code/sonnet --task escrow_basic
./benchmark run-all --model mock/reference --track native --difficulty hard --repeats 2
./benchmark run-all --model claude-code/sonnet --warm-cache
```

Inspect the latest saved sweep report:

```bash
./benchmark compare
./benchmark compare --latest 2
./benchmark compare --model claude-code/sonnet
./benchmark compare --suite ranking_v1
```

Run benchmark integrity checks over a full scope instead of one task:

```bash
./benchmark self-check --suite ranking_v1
./benchmark self-check --difficulty hard --track native
```

## What It Measures

- task completion behavior
- security-aware task structure
- framework-specific implementation fluency
- multi-instruction state-machine reasoning
- repair ability on partially broken smart-contract starters
- CPI and multi-program authority-flow reasoning
- reproducible offline evaluation
- suite-level comparison with category, track, and failure-hotspot breakdowns
- repeated sweeps for quick stability checks on the same slice

## Current Limitations

- retrieval mode is not implemented yet
- there is not yet a richer leaderboard-style or HTML reporting layer
- only two native tasks are implemented so far, and `vault_basic/native` currently validates a pre-created custody token account instead of creating an ATA inside the program
- Claude Code runs depend on a local authenticated `claude` CLI session
- Codex runs depend on a local authenticated `codex` CLI session, and Codex OSS routes require a local provider such as Ollama or LM Studio plus an installed model
- OpenCode runs depend on a local authenticated `opencode` CLI session; inside the Codex sandbox, OpenCode may fail on its local SQLite/WAL checkpoint path, so run those benchmarks from your normal terminal
- ranking-suite runs should stay sequential; overlapping Anchor/localnet-backed sweeps can interfere with each other
