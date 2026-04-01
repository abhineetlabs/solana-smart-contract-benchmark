# Scratchpad

## Project Intent

- Build a local, reproducible Solana smart contract LLM benchmark from the blueprint.
- Keep the implementation resumable if the active LLM session is lost.

## Current Phase

- Phase 1 first milestone completed.
- Current completed goal: one Anchor-flavored task, one mock adapter, one end-to-end run, saved artifacts.
- Next goal: add hidden/adversarial test plumbing and benchmark self-validation paths.

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

1. Commit the first runnable milestone using conventional commit formatting.
2. Add hidden test injection support in the runner.
3. Add adversarial test injection support in the runner.
4. Introduce simple failure-class tagging beyond `build_error`.
5. Add insecure baseline execution path and validation command.
6. Decide whether to keep lightweight Node-based track checks temporarily or install the full Anchor/Solana toolchain for real track execution.

## Milestones Reached

- Root npm workspace scaffold created.
- Core types, task discovery, and task validation implemented.
- CLI commands implemented: `validate`, `list tasks`, `list models`, `run`.
- Mock model adapter registry implemented.
- Isolated workspace runner implemented with prompt rendering, file-map validation, command execution, and artifact persistence.
- First task added: `counter_authority` on the `anchor` track.
- Verified commands:
  - `npm run typecheck`
  - `./benchmark validate`
  - `./benchmark list tasks`
  - `./benchmark list models`
  - `./benchmark run --model mock/reference --track anchor --task counter_authority`
- Latest verified reference-style run result:
  - build passed
  - public tests passed `5/5`
  - score `1.0`

## Risks / Follow-Ups

- The initial runnable task may need to use lightweight local validation commands until a full Anchor toolchain is installed.
- Hidden and adversarial tests should be introduced immediately after the first end-to-end path is stable.
- Current first milestone uses Node-based fixture checks inside the Anchor-shaped task scaffold because the local environment does not yet have Anchor/Solana installed.
- Public testing currently relies on source-shape assertions rather than actual Anchor execution, so the harness structure is validated before the full Solana execution environment is available.
