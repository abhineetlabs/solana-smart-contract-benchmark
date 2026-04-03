# Private Personal Suites

Put private suite JSON files in this directory when you want to benchmark against unpublished or workflow-specific tasks without committing them.

These files are ignored by git by default.

Helpful pattern:

1. Copy `personal_ranking_v1.example.json`.
2. Rename it to something like `personal_private_v1.json`.
3. Replace placeholder task ids with real private tasks from `tasks-private/` or with a curated slice of public tasks.
4. Run `./benchmark list suites` and `./benchmark run-all --suite <id>`.
