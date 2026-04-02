# Scratchpad

## Project Intent

- Build a local, reproducible Solana smart contract LLM benchmark from the blueprint.
- Keep the implementation resumable if the active LLM session is lost.

## Current Phase

- Phase 2 core plumbing is complete for the first task.
- Current completed goal: the benchmark now supports both mock baselines and real Claude Code CLI execution for `counter_authority`.
- Current next goal: add a second task and expand beyond the first vertical slice.

## Decisions Made

- Use npm workspaces for the initial scaffold because npm is available locally and `pnpm` bootstrap is currently blocked by a sandbox cache permission issue.
- Keep the repository layout close to the blueprint, but avoid over-splitting packages before the first runnable milestone exists.
- Keep a continuity log in this file and update it as major milestones land.
- Use `npm install --ignore-scripts` with a temporary cache path for local dependency installation because of current supply-chain sensitivity and recent npm ecosystem concerns.
- Use the existing system Rust, Anchor, and Solana installations rather than provisioning another global toolchain.
- Use real `anchor build` for the build stage and Anchor's `test --run <suite>` flow for public, hidden, and adversarial Rust suites.
- Keep a shared benchmark-local Cargo cache via `BENCHMARK_CARGO_HOME` and a shared benchmark-local Cargo target directory via `BENCHMARK_CARGO_TARGET_DIR`.
- Use a repo-local localnet wallet in the task starter so the benchmark does not depend on the developer's personal Solana wallet path.
- Skip runtime-only directories and socket files when copying workspaces into temp runs or persisted artifacts.
- Use the local `claude` CLI in print mode with tools disabled and structured JSON output so Claude Code subscription plans can be benchmarked without an Anthropic API key.
- Run Claude Code benchmark invocations from a temporary clean directory to avoid accidental project-context leakage from the benchmark repo itself.

## Environment Notes

- Node available: `v24.10.0`
- npm available: `11.6.1`
- TypeScript workspace install is present
- Existing local toolchain confirmed:
  - `rustc 1.91.1`
  - `cargo 1.91.1`
  - `anchor-cli 0.32.1`
  - `solana-cli 3.1.11`

## Immediate Work Queue

1. Add a second task, preferably `escrow_basic` or `vault_basic`.
2. Improve failure-class mapping from test names and failure payloads.
3. Add `native` track support only after a second task is stable.
4. Add result comparison/reporting helpers once there is more than one meaningful model/task combination.

## Milestones Reached

- Root npm workspace scaffold created.
- Core types, task discovery, and task validation implemented.
- CLI commands implemented: `validate`, `list tasks`, `list models`, `run`.
- Mock model adapter registry implemented.
- Isolated workspace runner implemented with prompt rendering, file-map validation, command execution, and artifact persistence.
- First task added: `counter_authority` on the `anchor` track.
- Hidden and adversarial test injection implemented for the first task.
- Baseline commands implemented:
  - `./benchmark baseline reference --track anchor --task counter_authority`
  - `./benchmark baseline insecure --track anchor --task counter_authority`
- Structured failure result path implemented for invalid model output.
- Simple failure-class tagging implemented.
- `benchmark self-check` implemented to validate the reference, insecure, and invalid-json baselines together.
- `benchmark warm-cache` implemented to prefetch/build the Anchor task and Rust suite dependencies on a cold machine.
- `counter_authority` track converted from synthetic JS checks to a real Anchor path:
  - build stage runs `anchor build`
  - public tests run via `anchor test --run tests-public`
  - hidden tests run via injected `tests-hidden`
  - adversarial tests run via injected `tests-adversarial`
- Claude Code CLI adapter implemented:
  - available model ids include `claude-code/default`, `claude-code/sonnet`, and `claude-code/opus`
  - benchmark runs use Claude Code print mode with tools disabled and JSON schema enforcement
  - no Anthropic API key is required if the local Claude Code session is already authenticated
- Runner now supports:
  - shared benchmark-local Cargo cache via `BENCHMARK_CARGO_HOME`
  - shared benchmark-local Cargo target directory via `BENCHMARK_CARGO_TARGET_DIR`
  - workspace snapshot filtering to skip build/runtime artifacts and socket files
  - starter tree filtering so prompt rendering does not include `target`, `.tooling`, `.anchor`, or `node_modules`
- Verified commands:
  - `npm run typecheck`
  - `./benchmark validate`
  - `./benchmark list tasks`
  - `./benchmark list models`
  - `./benchmark warm-cache --track anchor --task counter_authority`
  - `./benchmark baseline reference --track anchor --task counter_authority`
  - `./benchmark baseline insecure --track anchor --task counter_authority`
  - `./benchmark run --model mock/invalid-json --track anchor --task counter_authority`
  - `./benchmark run --model claude-code/sonnet --track anchor --task counter_authority`
  - `./benchmark self-check`
- Latest verified reference-style run result:
  - build passed
  - public tests passed `3/3`
  - hidden tests passed `3/3`
  - adversarial tests passed `3/3`
  - score `1.0`
- Latest verified insecure baseline result:
  - public tests passed `3/3`
  - hidden tests passed `0/3`
  - adversarial tests passed `1/3`
  - score `0.5`
  - failure classes: `signer_validation`
- Latest verified invalid-output run result:
  - status `failed`
  - stage `model_output_validation`
  - score `0`
  - structured artifacts persisted under `results/`
- Latest verified Claude Code run result:
  - model `claude-code/sonnet`
  - build passed
  - public tests passed `3/3`
  - total score `1.0`
- Latest verified self-check result:
  - reference score `1.0`
  - insecure adversarial `1/3`
  - invalid-json status `failed`
  - overall result `passed`
- Latest verified warm-cache result:
  - build step passed
  - public suite warmup passed
  - hidden suite warmup passed
  - adversarial suite warmup passed

## Risks / Follow-Ups

- Baseline commands currently piggyback on the mock adapter plus fixture solutions; that is fine for early harness validation, but later we should add an explicit self-validation suite that does not conceptually depend on a model adapter.
- The earlier host-side `solana-program-test` route is no longer used because it hits `solana-invoke` behavior that is only implemented on the Solana target.
- The first Claude Code benchmark run can consume noticeable quota depending on the chosen Claude model and the prompt size.
- Hidden and adversarial suite manifests intentionally target the injected temp workspace layout, so committed lockfiles for those suites still require either the warm-cache workflow or a future manifest/layout refinement.
