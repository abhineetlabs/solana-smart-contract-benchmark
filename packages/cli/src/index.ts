#!/usr/bin/env node
import { parseArgs } from "node:util";

import { discoverTasks, validateAllTasks } from "../../core/src/index.js";
import { getAvailableModelIds } from "../../model-adapters/src/index.js";
import { runBenchmark } from "../../runner/src/index.js";

async function main(): Promise<void> {
  const [, , ...args] = process.argv;

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  const command = args[0];

  if (command === "validate") {
    await handleValidate();
    return;
  }

  if (command === "list") {
    await handleList(args.slice(1));
    return;
  }

  if (command === "run") {
    await handleRun(args.slice(1));
    return;
  }

  if (command === "baseline") {
    await handleBaseline(args.slice(1));
    return;
  }

  if (command === "self-check") {
    await handleSelfCheck(args.slice(1));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function handleValidate(): Promise<void> {
  const result = await validateAllTasks(process.cwd());

  if (!result.ok) {
    console.error("Task validation failed:");
    for (const issue of result.issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${result.tasks.length} task(s) successfully.`);
}

async function handleList(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "tasks") {
    const tasks = await discoverTasks(process.cwd());
    if (tasks.length === 0) {
      console.log("No tasks found.");
      return;
    }

    for (const task of tasks) {
      console.log(`${task.id}\t${task.spec.difficulty}\t${task.spec.supportedTracks.join(",")}`);
    }
    return;
  }

  if (subcommand === "models") {
    for (const modelId of getAvailableModelIds()) {
      console.log(modelId);
    }
    return;
  }

  throw new Error(`Unknown list subcommand: ${subcommand ?? "(missing)"}`);
}

async function handleRun(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      model: {
        type: "string",
      },
      track: {
        type: "string",
      },
      task: {
        type: "string",
      },
      mode: {
        type: "string",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  const modelId = values.model;
  const track = values.track;
  const taskId = values.task;
  const mode = values.mode as "offline" | "retrieval" | undefined;

  if (!modelId || !track || !taskId) {
    throw new Error("run requires --model, --track, and --task.");
  }

  const execution = await runBenchmark({
    rootDir: process.cwd(),
    modelId,
    track: track as "anchor" | "native" | "pinocchio",
    taskId,
    mode,
  });

  console.log(`Run complete: ${execution.result.attemptId}`);
  console.log(`Score: ${execution.result.score.total}`);
  console.log(`Build: ${execution.result.build.success ? "pass" : "fail"}`);
  console.log(
    `Public tests: ${execution.result.tests.public.passed}/${execution.result.tests.public.total}`,
  );
  if (execution.result.status === "failed" && execution.result.error) {
    console.log(`Failure stage: ${execution.result.error.stage}`);
    console.log(`Failure message: ${execution.result.error.message}`);
    process.exitCode = 1;
  }
  console.log(`Artifacts: ${execution.attemptDir}`);
}

async function handleBaseline(args: string[]): Promise<void> {
  const baselineType = args[0];
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      track: {
        type: "string",
      },
      task: {
        type: "string",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  const track = values.track;
  const taskId = values.task;

  if (!baselineType || !track || !taskId) {
    throw new Error("baseline requires a type plus --track and --task.");
  }

  const modelId =
    baselineType === "reference"
      ? "mock/reference"
      : baselineType === "insecure"
        ? "mock/insecure"
        : undefined;

  if (!modelId) {
    throw new Error(`Unknown baseline type: ${baselineType}`);
  }

  const execution = await runBenchmark({
    rootDir: process.cwd(),
    modelId,
    track: track as "anchor" | "native" | "pinocchio",
    taskId,
    mode: "offline",
  });

  console.log(`Baseline complete: ${baselineType}`);
  console.log(`Run: ${execution.result.attemptId}`);
  console.log(`Score: ${execution.result.score.total}`);
  console.log(
    `Tests: public ${execution.result.tests.public.passed}/${execution.result.tests.public.total}, hidden ${execution.result.tests.hidden.passed}/${execution.result.tests.hidden.total}, adversarial ${execution.result.tests.adversarial.passed}/${execution.result.tests.adversarial.total}`,
  );
  console.log(`Failure classes: ${execution.result.failureClasses.join(", ") || "none"}`);
}

async function handleSelfCheck(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      track: {
        type: "string",
      },
      task: {
        type: "string",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  const track = (values.track ?? "anchor") as "anchor" | "native" | "pinocchio";
  const taskId = values.task ?? "counter_authority";
  const failures: string[] = [];

  const reference = await runBenchmark({
    rootDir: process.cwd(),
    modelId: "mock/reference",
    track,
    taskId,
    mode: "offline",
  });

  if (reference.result.status !== "completed" || reference.result.score.total < 0.9999) {
    failures.push("reference baseline did not achieve a clean pass");
  }

  const insecure = await runBenchmark({
    rootDir: process.cwd(),
    modelId: "mock/insecure",
    track,
    taskId,
    mode: "offline",
  });

  if (
    insecure.result.status !== "completed" ||
    insecure.result.tests.adversarial.total === 0 ||
    insecure.result.tests.adversarial.passed >= insecure.result.tests.adversarial.total
  ) {
    failures.push("insecure baseline did not fail adversarial checks");
  }

  const invalid = await runBenchmark({
    rootDir: process.cwd(),
    modelId: "mock/invalid-json",
    track,
    taskId,
    mode: "offline",
  });

  if (invalid.result.status !== "failed" || invalid.result.error?.stage !== "model_output_validation") {
    failures.push("invalid-json baseline did not fail as a structured model-output validation error");
  }

  console.log(`Self-check task: ${taskId}`);
  console.log(`Reference score: ${reference.result.score.total}`);
  console.log(`Insecure adversarial: ${insecure.result.tests.adversarial.passed}/${insecure.result.tests.adversarial.total}`);
  console.log(`Invalid-json status: ${invalid.result.status}`);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Self-check passed.");
}

function printHelp(): void {
  console.log(`Usage:
  benchmark validate
  benchmark list tasks
  benchmark list models
  benchmark run --model <id> --track <track> --task <task> [--mode offline|retrieval]
  benchmark baseline <reference|insecure> --track <track> --task <task>
  benchmark self-check [--track <track>] [--task <task>]`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
