# Solana Smart Contract Benchmark

Local benchmark harness for evaluating LLM performance on Solana smart contract generation and repair tasks.

## Current Status

The repository is being built from the implementation blueprint in `docs/IMPLEMENTATION_BLUEPRINT.md`. The current benchmark now includes:

- ten working benchmark pairs:
  - `counter_authority` on `anchor` and `native`
  - `escrow_basic` on `anchor` and `native`
  - `vault_basic` on `anchor` and `native`
  - `multisig_treasury` on `anchor`
  - `staking_pool_rewards` on `anchor`
  - `vault_receipt_migration` on `anchor`
  - `vesting_router_cpi` on `anchor`
- a more demanding task mix focused on PDA custody, per-user accounting, threshold-controlled treasury execution, repair-style reward-accounting bugs, migration-state safety, and multi-program CPI claim flows
- a frozen `ranking_v1` suite for repeatable model-vs-model comparisons
- practical personal workflow suites: `daily_v1`, `hard_v1`, `nightmare_v1`, and `personal_ranking_v1`
- private task and private suite scaffolding under `tasks-private/` and `configs/suites/private/`
- mock baselines plus Claude Code, Codex CLI, Gemini CLI, and OpenCode adapters
- end-to-end benchmark runs with persisted artifacts and scores
- local self-check, warm-cache, run-all, compare, suite commands, and multi-attempt time-to-green runs

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
./benchmark warm-cache --track native --task escrow_basic
./benchmark warm-cache --track anchor --task vault_basic
./benchmark warm-cache --track native --task vault_basic
./benchmark warm-cache --track anchor --task multisig_treasury
./benchmark warm-cache --track anchor --task staking_pool_rewards
./benchmark warm-cache --track anchor --task vault_receipt_migration
./benchmark warm-cache --track anchor --task vesting_router_cpi
./benchmark baseline reference --track native --task counter_authority
./benchmark baseline reference --track native --task escrow_basic
./benchmark baseline reference --track native --task vault_basic
./benchmark baseline reference --track anchor --task staking_pool_rewards
./benchmark baseline reference --track anchor --task vault_receipt_migration
./benchmark baseline reference --track anchor --task vesting_router_cpi
./benchmark run --model mock/starter --track anchor --task staking_pool_rewards
./benchmark run --model mock/starter --track anchor --task vault_receipt_migration
./benchmark run --model mock/starter --track anchor --task vesting_router_cpi
./benchmark run --model claude-code/sonnet --track anchor --task counter_authority
./benchmark run --model codex/default --track anchor --task counter_authority
./benchmark run --model gemini/default --track anchor --task counter_authority
./benchmark run --model opencode/default --track anchor --task counter_authority
./benchmark run --model mock/starter --track anchor --task staking_pool_rewards --max-attempts 2
./benchmark run-all --model claude-code/sonnet --suite daily_v1 --max-attempts 2
./benchmark run-all --model claude-code/sonnet --suite personal_ranking_v1 --max-attempts 2
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
- `gemini/default`
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

The Gemini adapter accepts:

- `gemini/default`
- `gemini/<model>`

Examples:

```bash
./benchmark run --model gemini/default --track anchor --task counter_authority
./benchmark run --model gemini/gemini-2.5-pro --track anchor --task vesting_router_cpi
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

Run one of the workflow-oriented suites instead of the whole evolving task matrix:

```bash
./benchmark list suites
./benchmark run-all --model claude-code/sonnet --suite daily_v1 --max-attempts 2
./benchmark run-all --model claude-code/sonnet --suite hard_v1 --max-attempts 2
./benchmark run-all --model claude-code/sonnet --suite nightmare_v1 --max-attempts 2
./benchmark run-all --model claude-code/sonnet --suite personal_ranking_v1 --max-attempts 2
./benchmark run-all --model claude-code/sonnet --suite ranking_v1
./benchmark run-all --model codex/default --suite ranking_v1
./benchmark compare --suite personal_ranking_v1
```

Optional filters:

```bash
./benchmark run-all --model claude-code/sonnet --difficulty hard
./benchmark run-all --model claude-code/sonnet --track anchor
./benchmark run-all --model claude-code/sonnet --task escrow_basic
./benchmark run-all --model mock/reference --track native --difficulty hard --repeats 2
./benchmark run-all --model claude-code/sonnet --suite daily_v1 --max-attempts 3
./benchmark run-all --model claude-code/sonnet --warm-cache
```

For iterative dev-workflow testing instead of one-shot scoring:

```bash
./benchmark run --model claude-code/sonnet --track anchor --task staking_pool_rewards --max-attempts 3
./benchmark run-all --model codex/default --suite personal_ranking_v1 --max-attempts 2
```

Inspect the latest saved sweep report:

```bash
./benchmark compare
./benchmark compare --latest 2
./benchmark compare --model claude-code/sonnet
./benchmark compare --suite ranking_v1
```

Each sweep now writes two report artifacts under `results/sweeps/`:

- `<sweep-id>.json`: machine-readable report with model id, provider, suite/filters, scoring, and per-pair details
- `<sweep-id>.md`: human-readable summary with metadata, headline metrics, pair tables, aggregates, and failure hotspots

Run benchmark integrity checks over a full scope instead of one task:

```bash
./benchmark self-check --suite ranking_v1
./benchmark self-check --difficulty hard --track native
```

## Scoring

The benchmark now has two scoring layers:

- per-task attempt scoring
- cross-task sweep aggregation

Per-task attempt scores are still computed internally on a normalized `0.0` to `1.0` scale from the task spec's stage weights:

- build
- public tests
- hidden tests
- adversarial tests
- efficiency, currently unused

The CLI now displays those same values on a friendlier `0` to `100` scale. So a stored attempt score of `0.3833` will be shown as `38.33/100`.

Cross-task sweeps are no longer averaged equally by default. The benchmark now uses weighted averages:

- default matrix runs use difficulty weights: `easy=1`, `medium=2`, `hard=3`
- named suites can override this with explicit per-target weights
- `ranking_v1` now assigns higher weights to the more discriminative repair, migration, CPI, and native targets

That means a model can no longer offset weak performance on the hardest tasks just by cleaning up easier pairs.

For pure model benchmarking, runtime/provider failures at the `model_invoke` stage are excluded from the capability score instead of being counted as zero-scored task failures. The sweep report shows those separately as `excluded:model_invoke` so you can distinguish adapter/runtime issues from actual coding failures.

## Workflow Metrics

For personal model selection, the benchmark can now run multiple attempts per task and report:

- weighted score
- whether the model ever got to green
- whether it succeeded on the first attempt
- attempts used
- time to green

This is controlled with `--max-attempts <n>`. A first-pass success stops early. A model that never fully solves the task will consume all attempts and report `Green: no`.

That makes the benchmark much closer to an actual coding workflow where you care about:

- does the model get there eventually
- how many repair loops it needs
- how long it takes before you can move on

## Personal Suites

The repo now ships with four practical suite tiers:

- `daily_v1`: smaller, common smart-contract work for quick model checks
- `hard_v1`: realistic harder custody, accounting, and multisig tasks
- `nightmare_v1`: ugly repair, CPI, and migration tasks
- `personal_ranking_v1`: a workflow-weighted blend intended for picking your default daily model

`personal_ranking_v1` uses workflow-aware weight rules, so repair, migration, and native tasks count more heavily than easy public generation tasks.

## Private Holdouts

You can now keep unpublished tasks and suite definitions locally:

- `tasks-private/` for private benchmark tasks
- `configs/suites/private/` for private suite JSONs

Both are ignored by git by default, and the loader now discovers them automatically. Use the committed README/example files in those directories as scaffolding.

## What It Measures

- task completion behavior
- security-aware task structure
- framework-specific implementation fluency
- multi-instruction state-machine reasoning
- repair ability on partially broken smart-contract starters
- migration safety and state-compatibility reasoning
- CPI and multi-program authority-flow reasoning
- reproducible offline evaluation
- suite-level comparison with category, track, and failure-hotspot breakdowns
- repeated sweeps for quick stability checks on the same slice
- time-to-green and attempts-to-green for iterative workflow comparisons

## Current Limitations

- retrieval mode is not implemented yet
- there is not yet a richer leaderboard-style or HTML reporting layer
- only three native tasks are implemented so far, and both `escrow_basic/native` and `vault_basic/native` currently validate pre-created custody token accounts instead of creating them inside the program
- repair retries currently feed back benchmark failure details into the next attempt, which is useful for personal workflow selection but should not be treated as a contamination-resistant public benchmark mode
- Claude Code runs depend on a local authenticated `claude` CLI session
- Codex runs depend on a local authenticated `codex` CLI session, and Codex OSS routes require a local provider such as Ollama or LM Studio plus an installed model
- Gemini runs depend on a local authenticated `gemini` CLI session, and offline benchmark invocations will fail if Gemini uses any tools during the run
- OpenCode runs depend on a local authenticated `opencode` CLI session; inside the Codex sandbox, OpenCode may fail on its local SQLite/WAL checkpoint path, so run those benchmarks from your normal terminal
- ranking-suite runs should stay sequential; overlapping Anchor/localnet-backed sweeps can interfere with each other
