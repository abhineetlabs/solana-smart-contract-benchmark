# Private Tasks

Put unpublished or workflow-specific benchmark tasks in this directory.

The benchmark loader now discovers both:

- `tasks/`
- `tasks-private/`

That means you can keep private holdout tasks out of git while still using them in:

- `./benchmark validate`
- `./benchmark list tasks`
- `./benchmark run`
- `./benchmark run-all`

Recommended workflow:

1. Copy an existing task from `tasks/` into `tasks-private/<new_task_id>/`.
2. Change the task id, title, and prompt so it reflects your real unpublished workflow.
3. Keep the same folder structure:
   - `core/spec.json`
   - `core/prompt.md`
   - `<track>/starter`
   - `<track>/tests-hidden`
   - `<track>/tests-adversarial`
4. Add the task to a private suite under `configs/suites/private/`.
5. Prefer real holdouts over minor renames:
   - turn off public prompt assets when possible
   - add new hidden and adversarial coverage, not just copies of the public tests
   - bias toward native, repair, migration, CPI, and multi-user state-machine edge cases
6. For a serious frontier leaderboard, aim for at least 6 unpublished target pairs before trusting the ranking too much.
