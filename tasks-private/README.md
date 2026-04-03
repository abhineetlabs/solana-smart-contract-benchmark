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
