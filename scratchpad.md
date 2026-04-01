# Scratchpad

## Project Intent

- Build a local, reproducible Solana smart contract LLM benchmark from the blueprint.
- Keep the implementation resumable if the active LLM session is lost.

## Current Phase

- Phase 2 core plumbing is complete for the first task.
- Current completed goal: `counter_authority` now runs on a real Anchor build plus Anchor-driven Rust test suites instead of the earlier synthetic fixture checks.
- Current next goal: commit the real Anchor conversion milestone, then add a second task.

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

1. Commit the real Anchor conversion milestone.
2. Add a second task, preferably `escrow_basic` or `vault_basic`.
3. Add a small setup/prefetch path for Rust suite dependencies so the first Anchor run is more deterministic on a cold cache.
4. Improve failure-class mapping from test names and failure payloads.
5. Add `native` track support only after a second task is stable.

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
- `counter_authority` track converted from synthetic JS checks to a real Anchor path:
  - build stage runs `anchor build`
  - public tests run via `anchor test --run tests-public`
  - hidden tests run via injected `tests-hidden`
  - adversarial tests run via injected `tests-adversarial`
- Runner now supports:
  - shared benchmark-local Cargo cache via `BENCHMARK_CARGO_HOME`
  - shared benchmark-local Cargo target directory via `BENCHMARK_CARGO_TARGET_DIR`
  - workspace snapshot filtering to skip build/runtime artifacts and socket files
- Verified commands:
  - `npm run typecheck`
  - `./benchmark validate`
  - `./benchmark list tasks`
  - `./benchmark list models`
  - `./benchmark baseline reference --track anchor --task counter_authority`
  - `./benchmark baseline insecure --track anchor --task counter_authority`
  - `./benchmark run --model mock/invalid-json --track anchor --task counter_authority`
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
- Latest verified self-check result:
  - reference score `1.0`
  - insecure adversarial `1/3`
  - invalid-json status `failed`
  - overall result `passed`

## Risks / Follow-Ups

- Baseline commands currently piggyback on the mock adapter plus fixture solutions; that is fine for early harness validation, but later we should add an explicit self-validation suite that does not conceptually depend on a model adapter.
- The earlier host-side `solana-program-test` route is no longer used because it hits `solana-invoke` behavior that is only implemented on the Solana target.
- The first public Anchor suite run may still need to fetch Rust dependencies into the shared Cargo cache on a cold machine before hidden/adversarial suites can stay offline.
- Hidden and adversarial suite manifests intentionally target the injected temp workspace layout, so generating their lockfiles from the repo root will need either a prefetch step or a small helper workflow.
