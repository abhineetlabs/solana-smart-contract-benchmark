# Scratchpad

## Project Intent

- Build a local, reproducible Solana smart contract LLM benchmark from the blueprint.
- Keep the implementation resumable if the active LLM session is lost.

## Current Phase

- Phase 2 core plumbing completed for the first task.
- Current completed goal: hidden/adversarial injection, baseline validation commands, and structured failure results are working for `counter_authority`.
- Next goal: expand task coverage, improve failure taxonomy, and decide when to switch from lightweight fixture commands to the full Anchor/Solana toolchain.

## Decisions Made

- Use npm workspaces for the initial scaffold because npm is available locally and `pnpm` bootstrap is currently blocked by a sandbox cache permission issue.
- Keep the repository layout close to the blueprint, but avoid over-splitting packages before the first runnable milestone exists.
- Keep a continuity log in this file and update it as major milestones land.
- Use `npm install --ignore-scripts` with a temporary cache path for local dependency installation because of current supply-chain sensitivity and recent npm ecosystem concerns.

## Environment Notes

- Node available: `v24.10.0`
- npm available: `11.6.1`
- TypeScript not yet installed
- Solana/Anchor toolchain not currently available in the environment

## Immediate Work Queue

1. Commit the phase 2 benchmark validation milestone using conventional commit formatting.
2. Add a second task, preferably `vault_basic` or `escrow_basic`, before broad refactoring.
3. Add an explicit benchmark self-validation command that runs reference and insecure baselines together.
4. Improve failure-class mapping from test names and failure payloads.
5. Decide whether to keep lightweight Node-based track checks temporarily or install the full Anchor/Solana toolchain for real track execution.
6. Add `native` track support only after a second task is stable.

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
- Verified commands:
  - `npm run typecheck`
  - `./benchmark validate`
  - `./benchmark list tasks`
  - `./benchmark list models`
  - `./benchmark run --model mock/reference --track anchor --task counter_authority`
  - `./benchmark baseline reference --track anchor --task counter_authority`
  - `./benchmark baseline insecure --track anchor --task counter_authority`
  - `./benchmark run --model mock/invalid-json --track anchor --task counter_authority`
- Latest verified reference-style run result:
  - build passed
  - public tests passed `5/5`
  - hidden tests passed `3/3`
  - adversarial tests passed `3/3`
  - score `1.0`
- Latest verified insecure baseline result:
  - public tests passed `5/5`
  - hidden tests passed `2/3`
  - adversarial tests passed `1/3`
  - score `0.7`
  - failure classes: `signer_validation`
- Latest verified invalid-output run result:
  - status `failed`
  - stage `model_output_validation`
  - score `0`
  - structured artifacts persisted under `results/`

## Risks / Follow-Ups

- The initial runnable task may need to use lightweight local validation commands until a full Anchor toolchain is installed.
- Hidden and adversarial tests should be introduced immediately after the first end-to-end path is stable.
- Current first milestone uses Node-based fixture checks inside the Anchor-shaped task scaffold because the local environment does not yet have Anchor/Solana installed.
- Public testing currently relies on source-shape assertions rather than actual Anchor execution, so the harness structure is validated before the full Solana execution environment is available.
- Baseline commands currently piggyback on the mock adapter plus fixture solutions; that is fine for early harness validation, but later we should add an explicit self-validation suite that does not conceptually depend on a model adapter.
