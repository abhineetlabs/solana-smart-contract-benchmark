# Private Personal Suites

Put private suite JSON files in this directory when you want to benchmark against unpublished or workflow-specific tasks without committing them.

These files are ignored by git by default.

Helpful pattern:

1. Copy `personal_ranking_v1.example.json`.
2. Rename it to something like `personal_private_v1.json`.
3. Replace placeholder task ids with real private tasks from `tasks-private/` or with a curated slice of public tasks.
4. Run `./benchmark list suites` and `./benchmark run-all --suite <id>`.

For frontier-model ranking, a stronger pattern is:

1. Start from the public `leaderboard_v1` mix.
2. Add at least 6 unpublished holdout target pairs from `tasks-private/`.
3. Weight native, repair, migration, CPI, and multisig/state-machine holdouts more heavily than easy generate tasks.
4. Use `--max-attempts 1 --strict-capability --runtime-retries 4 --require-full-sweep` so model comparisons stay clean.
