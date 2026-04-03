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
./benchmark run-all --model claude-code/sonnet --suite personal_ranking_v1 --max-attempts 2 --strict-capability
./benchmark run-all --model claude-code/sonnet --suite ranking_v1
./benchmark run-all --model mock/reference --track native --difficulty hard --repeats 2
./benchmark compare
./benchmark compare --suite ranking_v1
./benchmark self-check --suite ranking_v1
```

## Recommended Usage

If your goal is a pure model benchmark rather than a provider reliability benchmark:

1. Prefer direct adapters when available:
   - `claude-code/...`
   - `codex/...`
   - `gemini/...`
2. Use `--strict-capability` on `run` or `run-all`.
   - this retries `model_invoke` failures before giving up
   - if the model still never returns usable output, that target is excluded from the capability score instead of being counted as a model zero
3. Use `--runtime-retries <n>` if you want to change how many extra transport retries are allowed in strict-capability mode.
4. Use `--max-attempts <n>` for actual repair-style benchmark attempts after a usable model response exists.
5. Use `--require-full-sweep` on expensive comparison runs when you need exact model-to-model comparability.
   - the command exits non-zero if any target is still runtime-excluded
   - this prevents partial sweeps from being compared against complete ones
6. `run` and `run-all` now print live stage progress so the terminal is not blank while a target is building or testing.

Recommended pure-capability commands:

```bash
./benchmark run-all --model claude-code/sonnet --suite personal_ranking_v1 --max-attempts 2 --strict-capability --runtime-retries 4 --require-full-sweep
./benchmark run-all --model codex/default --suite personal_ranking_v1 --max-attempts 2 --strict-capability --runtime-retries 4 --require-full-sweep
./benchmark run-all --model gemini/default --suite personal_ranking_v1 --max-attempts 2 --strict-capability --runtime-retries 4 --require-full-sweep
./benchmark compare --suite personal_ranking_v1
```

For open-weight local models:

```bash
./benchmark run-all --model codex-oss/ollama/<model> --suite personal_ranking_v1 --strict-capability --runtime-retries 4 --require-full-sweep
./benchmark run-all --model codex-oss/lmstudio/<model> --suite personal_ranking_v1 --strict-capability --runtime-retries 4 --require-full-sweep
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
./benchmark run-all --model claude-code/sonnet --suite personal_ranking_v1 --max-attempts 2 --strict-capability --runtime-retries 4 --require-full-sweep
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
./benchmark run-all --model claude-code/sonnet --suite daily_v1 --max-attempts 3 --strict-capability --runtime-retries 4 --require-full-sweep
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

## CLI Reference

This section is intentionally verbose. The goal is that you should be able to understand every command and every important flag without having to infer behavior from examples.

### `benchmark validate`

Validates every discovered public task and private task.

Use it when:

- you added or changed task files
- you pulled new benchmark changes
- you want to make sure the repo is internally consistent before spending money on model runs

Command:

```bash
./benchmark validate
```

### `benchmark list tasks`

Shows every task id, its difficulty, and supported tracks.

Command:

```bash
./benchmark list tasks
```

### `benchmark list models`

Shows the built-in model ids currently exposed by the installed adapters.

Command:

```bash
./benchmark list models
```

### `benchmark list suites`

Shows the named suites you can pass to `run-all` and `compare`.

Command:

```bash
./benchmark list suites
```

### `benchmark warm-cache`

Pre-builds dependencies for one task/track pair so the first real benchmark run is less cold and less surprising.

Command shape:

```bash
./benchmark warm-cache --track <track> --task <task>
```

#### `--track <track>`

Selects which implementation track to warm.

Typical values:

- `anchor`
- `native`

#### `--task <task>`

Selects which task id to warm.

Example:

```bash
./benchmark warm-cache --track anchor --task counter_authority
```

### `benchmark run`

Runs one task/track pair and writes one run manifest plus one attempt result directory.

Use it when:

- you want to inspect one specific task closely
- you are debugging one model on one benchmark target
- you want to test a new adapter/model without paying for a full sweep

Command shape:

```bash
./benchmark run --model <id> --track <track> --task <task> [flags]
```

#### `--model <id>`

Chooses the adapter/model id to run.

Examples:

- `claude-code/sonnet`
- `codex/default`
- `gemini/default`
- `opencode/opencode/glm-5`

#### `--track <track>`

Chooses the implementation track for the task.

Typical values:

- `anchor`
- `native`

#### `--task <task>`

Chooses the benchmark task id.

Examples:

- `counter_authority`
- `escrow_basic`
- `staking_pool_rewards`

#### `--mode offline|retrieval`

Chooses the invocation mode.

Current practical guidance:

- use `offline`
- retrieval is reserved for future pinned-docs evaluation

#### `--max-attempts <n>`

Controls benchmark repair attempts after the model has already produced a valid usable output.

What it means:

- `1` means one shot only
- `2` or higher allows the model to receive benchmark feedback and try again

What it does **not** mean:

- it does not control provider/runtime retries
- it does not retry `model_invoke` transport failures

#### `--strict-capability`

Turns on capability-focused execution.

What it does:

- retries `model_invoke` failures before giving up
- excludes persistent `model_invoke` failures from the capability score instead of treating them as model zeros

Use it when:

- you care about model ability, not provider flakiness
- you want cleaner cross-model comparisons

#### `--runtime-retries <n>`

Controls extra retries for `model_invoke` failures when `--strict-capability` is on.

What it means:

- `0` means no extra transport retries
- `1` means one extra provider retry after the first invoke failure
- `4` is a good higher-confidence value for expensive comparison runs

Important:

- this is separate from `--max-attempts`
- runtime retries happen before a valid response exists

#### Live Progress During `run`

`run` now prints progress automatically while it is working.

You will see lines for:

- attempt start
- invoke start and finish
- build start and finish
- public/hidden/adversarial test start and finish

Examples:

```bash
./benchmark run --model claude-code/sonnet --track anchor --task counter_authority --strict-capability --runtime-retries 2
./benchmark run --model codex/default --track anchor --task staking_pool_rewards --max-attempts 3 --strict-capability --runtime-retries 2
```

### `benchmark run-all`

Runs a sweep and produces a final aggregate report.

Use it when:

- you want a real benchmark score
- you want a suite-level comparison between models
- you want one final report instead of many single-task runs

Command shape:

```bash
./benchmark run-all --model <id> [flags]
```

It can operate in three modes:

- full matrix mode: no suite/task/track filter
- suite mode: `--suite <suite>`
- filtered mode: `--track`, `--task`, and/or `--difficulty`

`run-all` is sequential, not parallel. That is deliberate, because overlapping Solana/Anchor-backed runs can interfere with one another.

#### `--model <id>`

Chooses the model id for the whole sweep.

This flag is required.

#### `--suite <suite>`

Runs a named curated suite instead of the whole evolving matrix.

Examples:

- `daily_v1`
- `hard_v1`
- `nightmare_v1`
- `personal_ranking_v1`
- `ranking_v1`

Use this when you want stable comparisons.

#### `--track <track>`

Filters the sweep to one track when you are **not** using `--suite`.

Example:

```bash
./benchmark run-all --model codex/default --track native
```

#### `--task <task>`

Filters the sweep to one task when you are **not** using `--suite`.

This is useful when you want a sweep-style report for a single target.

#### `--difficulty easy|medium|hard`

Filters the sweep by task difficulty when you are **not** using `--suite`.

Example:

```bash
./benchmark run-all --model claude-code/sonnet --difficulty hard
```

#### `--mode offline|retrieval`

Chooses invocation mode for the sweep.

Current practical guidance:

- use `offline`
- retrieval is future-facing

#### `--repeats <n>`

Repeats the entire same sweep multiple times.

Use it when:

- you want to measure stability
- you want multiple sweep ids for later comparison

Example:

```bash
./benchmark run-all --model gemini/default --suite ranking_v1 --repeats 3
```

#### `--max-attempts <n>`

Controls repair attempts per target after a valid model response exists.

This is the sweep-wide version of the same flag in `run`.

#### `--strict-capability`

Turns on capability-focused scoring for the whole sweep.

What it does:

- retries `model_invoke` failures using `--runtime-retries`
- excludes persistent `model_invoke` failures from the capability score

#### `--runtime-retries <n>`

Controls extra provider/runtime retries for each target when `--strict-capability` is enabled.

Practical recommendation:

- use `4` for expensive serious comparison runs

#### `--require-full-sweep`

This is the most important safety flag for expensive cross-model comparisons.

What it does:

- fails the entire command if any target is still runtime-excluded after retries
- prevents you from comparing a partial sweep for one model against a complete sweep for another model

Use it when:

- the run is expensive
- you care about comparability
- you want the command to fail loudly instead of quietly producing a partial report

#### `--warm-cache`

Runs warm-cache behavior for each target before benchmarking it.

Use it when:

- you want to reduce cold-start surprises
- you are doing a fresh first run on a machine

#### Live Progress During `run-all`

`run-all` now prints progress automatically while it is working.

You will see lines for:

- target start
- warm-cache start and finish
- attempt start
- model invoke start and finish
- build start and finish
- public/hidden/adversarial test start and finish
- target finish

Examples:

```bash
./benchmark run-all --model claude-code/sonnet --suite personal_ranking_v1 --max-attempts 2 --strict-capability --runtime-retries 4 --require-full-sweep
./benchmark run-all --model codex/default --track native --difficulty hard --strict-capability --runtime-retries 4 --require-full-sweep
./benchmark run-all --model gemini/default --suite ranking_v1 --repeats 3 --strict-capability --runtime-retries 4 --require-full-sweep
```

### `benchmark baseline`

Runs a built-in benchmark baseline on one task/track pair.

Command shape:

```bash
./benchmark baseline <reference|insecure> --track <track> --task <task>
```

#### `reference`

Uses the benchmark’s known-good reference solution.

Use it when:

- you want to confirm the target is healthy
- you want a known `100/100` control

#### `insecure`

Uses the benchmark’s intentionally insecure solution.

Use it when:

- you want to confirm hidden/adversarial tests are catching the intended weakness

### `benchmark compare`

Reads saved sweep reports and prints comparison summaries.

Command shape:

```bash
./benchmark compare [<sweep-id> ...] [flags]
```

#### `--latest <n>`

Loads the latest `n` sweep reports when you do not pass explicit sweep ids.

#### `--model <id>`

Filters saved sweep reports to one model id.

#### `--suite <suite>`

Filters saved sweep reports to one suite id.

Examples:

```bash
./benchmark compare
./benchmark compare --latest 2
./benchmark compare --model claude-code/sonnet
./benchmark compare --suite personal_ranking_v1
```

### `benchmark self-check`

Runs benchmark integrity checks using the built-in baselines.

Command shape:

```bash
./benchmark self-check [flags]
```

#### `--suite <suite>`

Runs self-check across every target in the named suite.

#### `--track <track>`

Filters self-check to one track or a difficulty slice.

#### `--task <task>`

Runs self-check on one exact target.

#### `--difficulty <level>`

Filters self-check by difficulty without using a named suite.

Examples:

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

`--strict-capability` improves this further by retrying `model_invoke` failures a few times before exclusion. This is different from `--max-attempts`:

- `--runtime-retries` handles transport/provider failures before a valid model response exists
- `--max-attempts` handles repair-style benchmark attempts after a valid model response exists
- `--require-full-sweep` makes the command fail if any target is still runtime-excluded after retries, which is the safest setting for expensive model-to-model comparisons

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
