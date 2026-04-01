import { validateAllTasks } from "../packages/core/src/index.js";

const outcome = await validateAllTasks(process.cwd());

if (!outcome.ok) {
  for (const issue of outcome.issues) {
    console.error(`- ${issue}`);
  }

  process.exitCode = 1;
} else {
  console.log(`Validated ${outcome.tasks.length} task(s).`);
}
