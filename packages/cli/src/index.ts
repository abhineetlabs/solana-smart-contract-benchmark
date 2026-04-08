#!/usr/bin/env node
import { readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { discoverTasks, validateAllTasks, type Difficulty } from "../../core/src/index.js";
import { getAvailableModelIds } from "../../model-adapters/src/index.js";
import type { BenchmarkReasoningEffort } from "../../model-adapters/src/index.js";
import {
  listAvailableSuites,
  listBenchmarkTargets,
  loadSweepReports,
  resumeBenchmarkSweep,
  runBenchmark,
  runBenchmarkSweep,
  warmTaskCache,
  type SweepEntry,
  type SweepReport,
} from "../../runner/src/index.js";

const BENCHMARK_TEMP_PREFIXES = [
  "solana-llm-benchmark-",
  "solana-llm-benchmark-warm-",
  "codex-cli-benchmark-",
  "claude-code-benchmark-",
  "gemini-cli-benchmark-",
  "opencode-benchmark-",
] as const;

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

  if (command === "run-all") {
    await handleRunAll(args.slice(1));
    return;
  }

  if (command === "resume-sweep") {
    await handleResumeSweep(args.slice(1));
    return;
  }

  if (command === "warm-cache") {
    await handleWarmCache(args.slice(1));
    return;
  }

  if (command === "clean") {
    await handleClean(args.slice(1));
    return;
  }

  if (command === "compare") {
    await handleCompare(args.slice(1));
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

  if (subcommand === "suites") {
    const suites = await listAvailableSuites(process.cwd());
    if (suites.length === 0) {
      console.log("No suites found.");
      return;
    }

    for (const suite of suites) {
      console.log(`${suite.id}\t${suite.targets.length}\t${suite.tags?.join(",") ?? "-"}\t${suite.title}`);
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
      "reasoning-effort": {
        type: "string",
      },
      "max-attempts": {
        type: "string",
      },
      "strict-capability": {
        type: "boolean",
      },
      "runtime-retries": {
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
  const reasoningEffort = parseReasoningEffortOption(values["reasoning-effort"]);
  const maxAttempts = values["max-attempts"] ? Number(values["max-attempts"]) : 1;
  const strictCapability = values["strict-capability"] ?? false;
  const runtimeRetryLimit = values["runtime-retries"] ? Number(values["runtime-retries"]) : 2;

  if (!modelId || !track || !taskId) {
    throw new Error("run requires --model, --track, and --task.");
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("run --max-attempts must be a positive integer.");
  }

  if (values["runtime-retries"] && (!Number.isInteger(runtimeRetryLimit) || runtimeRetryLimit < 0)) {
    throw new Error("run --runtime-retries must be a non-negative integer.");
  }

  const execution = await runBenchmark({
    rootDir: process.cwd(),
    modelId,
    track: track as "anchor" | "native" | "pinocchio",
    taskId,
    mode,
    reasoningEffort,
    maxAttempts,
    strictCapability,
    runtimeRetryLimit,
    onProgress: (message) => console.log(`[progress] ${message}`),
  });

  console.log(`Run complete: ${execution.result.attemptId}`);
  console.log(
    `Reasoning effort: ${formatReasoningEffortSummary(
      execution.result.model.reasoningEffort,
      execution.result.model.providerReasoningEffort,
    )}`,
  );
  console.log(`Score: ${formatScore(execution.result.score.total)}/100`);
  console.log(`Attempts: ${execution.run.attemptCount}/${execution.run.maxAttempts}`);
  console.log(
    `Strict capability: ${execution.run.strictCapability ? `yes (${execution.run.runtimeRetriesUsed} retries used, limit ${execution.run.runtimeRetryLimit})` : "no"}`,
  );
  console.log(`Green: ${execution.run.reachedGreen ? `yes (attempt ${execution.run.greenAttemptNumber}, ${formatDurationMs(execution.run.timeToGreenMs)})` : "no"}`);
  console.log(`Build: ${execution.result.build.success ? "pass" : "fail"}`);
  console.log(
    `Model invokes: ${execution.result.invocationAttempts} (${execution.result.runtimeRetriesUsed} retries)`,
  );
  console.log(
    `Public tests: ${execution.result.tests.public.passed}/${execution.result.tests.public.total}`,
  );
  const routedProvider = execution.result.model.providerMetadata?.routingProvider;
  if (typeof routedProvider === "string" && routedProvider.trim() !== "") {
    console.log(`Routed provider: ${routedProvider}`);
  }
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
  console.log(`Score: ${formatScore(execution.result.score.total)}/100`);
  console.log(
    `Tests: public ${execution.result.tests.public.passed}/${execution.result.tests.public.total}, hidden ${execution.result.tests.hidden.passed}/${execution.result.tests.hidden.total}, adversarial ${execution.result.tests.adversarial.passed}/${execution.result.tests.adversarial.total}`,
  );
  console.log(`Failure classes: ${execution.result.failureClasses.join(", ") || "none"}`);
}

async function handleRunAll(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      difficulty: {
        type: "string",
      },
      model: {
        type: "string",
      },
      repeats: {
        type: "string",
      },
      mode: {
        type: "string",
      },
      suite: {
        type: "string",
      },
      track: {
        type: "string",
      },
      task: {
        type: "string",
      },
      "warm-cache": {
        type: "boolean",
      },
      "reasoning-effort": {
        type: "string",
      },
      "max-attempts": {
        type: "string",
      },
      "strict-capability": {
        type: "boolean",
      },
      "runtime-retries": {
        type: "string",
      },
      "require-full-sweep": {
        type: "boolean",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  const modelId = values.model;
  if (!modelId) {
    throw new Error("run-all requires --model.");
  }

  if (values.suite && (values.track || values.task || values.difficulty)) {
    throw new Error("run-all cannot combine --suite with --track, --task, or --difficulty.");
  }

  const repeats = values.repeats ? Number(values.repeats) : 1;
  const reasoningEffort = parseReasoningEffortOption(values["reasoning-effort"]);
  const maxAttempts = values["max-attempts"] ? Number(values["max-attempts"]) : 1;
  const strictCapability = values["strict-capability"] ?? false;
  const runtimeRetryLimit = values["runtime-retries"] ? Number(values["runtime-retries"]) : 2;
  const requireFullSweep = values["require-full-sweep"] ?? false;
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error("run-all --repeats must be a positive integer.");
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("run-all --max-attempts must be a positive integer.");
  }

  if (values["runtime-retries"] && (!Number.isInteger(runtimeRetryLimit) || runtimeRetryLimit < 0)) {
    throw new Error("run-all --runtime-retries must be a non-negative integer.");
  }

  const reports: SweepReport[] = [];
  for (let index = 0; index < repeats; index += 1) {
    const report = await runBenchmarkSweep({
      rootDir: process.cwd(),
      difficulty: values.difficulty as Difficulty | undefined,
      modelId,
      mode: values.mode as "offline" | "retrieval" | undefined,
      reasoningEffort,
      suiteId: values.suite,
      track: values.track as "anchor" | "native" | "pinocchio" | undefined,
      taskId: values.task,
      warmCache: values["warm-cache"],
      maxAttempts,
      strictCapability,
      runtimeRetryLimit,
      onProgress: (message) => console.log(`[progress] ${message}`),
    });
    reports.push(report);

    if (repeats === 1) {
      printSweepReport(report);
    } else {
      console.log(
        `Repeat ${index + 1}/${repeats}: ${report.sweepId} weighted average ${formatScore(report.summary.averageScore)}/100 green ${formatStageRatio(report.summary.greenTargets, report.summary.totalTargets)} first-pass ${formatStageRatio(report.summary.firstPassGreenTargets, report.summary.totalTargets)} avg attempts ${formatAttempts(report.summary.averageAttemptsUsed)}`,
      );
    }

    if (requireFullSweep && report.summary.runtimeExcludedTargets > 0) {
      console.error(
        `Incomplete sweep: ${report.summary.runtimeExcludedTargets} target(s) were excluded at runtime. Increase --runtime-retries or rerun before comparing models.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (repeats > 1) {
    printSweepOverview(reports);
    printModelAggregateSection(reports);
  }

  if (reports.some((report) => report.summary.failedTargets > 0)) {
    process.exitCode = 1;
  }
}

async function handleResumeSweep(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      latest: {
        type: "boolean",
      },
      "retry-benchmark-faults": {
        type: "boolean",
      },
      "retry-target": {
        type: "string",
      },
      "retry-stage": {
        type: "string",
      },
      "skip-runtime-excluded": {
        type: "boolean",
      },
      "warm-cache": {
        type: "boolean",
      },
      "require-full-sweep": {
        type: "boolean",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length > 1) {
    throw new Error("resume-sweep accepts at most one explicit sweep ID.");
  }

  if (positionals[0] && values.latest) {
    throw new Error("resume-sweep cannot combine an explicit sweep ID with --latest.");
  }

  const sourceSweepId = await resolveResumeSweepId({
    rootDir: process.cwd(),
    explicitSweepId: positionals[0],
    useLatest: values.latest ?? false,
  });

  const retryStages = mergeUniqueStages(
    parseCsvList(values["retry-stage"]),
    values["retry-benchmark-faults"] ? DEFAULT_BENCHMARK_RETRY_STAGES : [],
  );
  const retryTargetKeys = parseRetryTargetKeys(values["retry-target"]);
  const retryRuntimeExcluded = !(values["skip-runtime-excluded"] ?? false);
  if (!retryRuntimeExcluded && retryStages.length === 0 && retryTargetKeys.length === 0) {
    throw new Error("resume-sweep requires runtime exclusions, --retry-stage, or --retry-target.");
  }

  const report = await resumeBenchmarkSweep({
    rootDir: process.cwd(),
    sourceSweepId,
    retryRuntimeExcluded,
    retryStages,
    retryTargetKeys,
    warmCache: values["warm-cache"] ?? false,
    onProgress: (message) => console.log(`[progress] ${message}`),
  });

  printSweepReport(report);

  if ((values["require-full-sweep"] ?? false) && report.summary.runtimeExcludedTargets > 0) {
    console.error(
      `Incomplete sweep: ${report.summary.runtimeExcludedTargets} target(s) were excluded at runtime. Increase --runtime-retries or resume the sweep again before comparing models.`,
    );
    process.exitCode = 1;
    return;
  }

  if (report.summary.failedTargets > 0) {
    process.exitCode = 1;
  }
}

async function handleSelfCheck(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      difficulty: {
        type: "string",
      },
      suite: {
        type: "string",
      },
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

  if (values.suite && (values.task || values.track || values.difficulty)) {
    throw new Error("self-check cannot combine --suite with --task, --track, or --difficulty.");
  }

  if (!values.task && (values.suite || values.difficulty)) {
    const targets = await listBenchmarkTargets({
      rootDir: process.cwd(),
      suiteId: values.suite,
      track: values.track as "anchor" | "native" | "pinocchio" | undefined,
      difficulty: values.difficulty as Difficulty | undefined,
    });

    if (targets.length === 0) {
      throw new Error("No matching task/track pairs found for self-check.");
    }

    const failures: string[] = [];
    const invalidTarget = targets[0];
    if (!invalidTarget) {
      throw new Error("No matching task/track pairs found for self-check.");
    }
    const invalid = await runBenchmark({
      rootDir: process.cwd(),
      modelId: "mock/invalid-json",
      track: invalidTarget.track,
      taskId: invalidTarget.taskId,
      mode: "offline",
    });

    if (invalid.result.status !== "failed" || invalid.result.error?.stage !== "model_output_validation") {
      failures.push("invalid-json baseline did not fail as a structured model-output validation error");
    }

    console.log(`Self-check scope: ${values.suite ? `suite ${values.suite}` : `difficulty ${values.difficulty}`}`);
    console.log(`Invalid-json target: ${invalidTarget.taskId}/${invalidTarget.track} -> ${invalid.result.status}`);

    let passedTargets = 0;
    for (const target of targets) {
      const reference = await runBenchmark({
        rootDir: process.cwd(),
        modelId: "mock/reference",
        track: target.track,
        taskId: target.taskId,
        mode: "offline",
      });
      const insecure = await runBenchmark({
        rootDir: process.cwd(),
        modelId: "mock/insecure",
        track: target.track,
        taskId: target.taskId,
        mode: "offline",
      });

      const targetFailures: string[] = [];
      if (reference.result.status !== "completed" || reference.result.score.total < 0.9999) {
        targetFailures.push("reference baseline did not achieve a clean pass");
      }

      if (
        insecure.result.status !== "completed" ||
        insecure.result.tests.adversarial.total === 0 ||
        insecure.result.tests.adversarial.passed >= insecure.result.tests.adversarial.total
      ) {
        targetFailures.push("insecure baseline did not fail adversarial checks");
      }

      if (targetFailures.length === 0) {
        passedTargets += 1;
      } else {
        for (const failure of targetFailures) {
          failures.push(`${target.taskId}/${target.track}: ${failure}`);
        }
      }

      console.log(
        `${target.taskId}/${target.track}: reference ${formatScore(reference.result.score.total)}/100, insecure adversarial ${formatStageRatio(insecure.result.tests.adversarial.passed, insecure.result.tests.adversarial.total)}`,
      );
    }

    console.log(`Summary: passed ${passedTargets}/${targets.length}`);
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`- ${failure}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log("Self-check passed.");
    return;
  }

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
  console.log(`Reference score: ${formatScore(reference.result.score.total)}/100`);
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

async function handleWarmCache(args: string[]): Promise<void> {
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

  const track = values.track;
  const taskId = values.task;

  if (!track || !taskId) {
    throw new Error("warm-cache requires --track and --task.");
  }

  const result = await warmTaskCache({
    rootDir: process.cwd(),
    track: track as "anchor" | "native" | "pinocchio",
    taskId,
  });

  console.log(`Warm-cache complete: ${result.taskId} (${result.track})`);
  for (const step of result.steps) {
    console.log(`- ${step.name}: ${step.success ? "ok" : "fail"} (${step.durationMs} ms)`);
  }
}

async function handleClean(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      all: {
        type: "boolean",
      },
      results: {
        type: "boolean",
      },
      tooling: {
        type: "boolean",
      },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.all && (values.results || values.tooling)) {
    throw new Error("clean --all cannot be combined with --results or --tooling.");
  }

  const cleanTooling = values.all || values.tooling || (!values.results && !values.all && !values.tooling);
  const cleanResults = values.all || values.results;
  const rootDir = process.cwd();

  if (cleanTooling) {
    await rm(path.join(rootDir, ".tooling"), { recursive: true, force: true });
    console.log("Cleared .tooling cache.");
  }

  const leakedTempEntriesRemoved =
    (await removePrefixedEntries(tmpdir(), BENCHMARK_TEMP_PREFIXES))
    + (await removePrefixedEntries(path.join(homedir(), ".gemini", "history"), ["gemini-cli-benchmark-"]))
    + (await removePrefixedEntries(path.join(homedir(), ".gemini", "tmp"), ["gemini-cli-benchmark-"]));
  console.log(`Removed ${leakedTempEntriesRemoved} leaked temp entr${pluralize(leakedTempEntriesRemoved, "y", "ies")}.`);

  if (cleanResults) {
    const removedResultsEntries = await clearDirectoryContents(path.join(rootDir, "results"), new Set([".gitkeep"]));
    console.log(`Removed ${removedResultsEntries} results entr${pluralize(removedResultsEntries, "y", "ies")}.`);
  }
}

async function handleCompare(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      latest: {
        type: "string",
      },
      model: {
        type: "string",
      },
      suite: {
        type: "string",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  const latest = values.latest ? Number(values.latest) : undefined;
  if (values.latest && (!Number.isInteger(latest) || (latest ?? 0) <= 0)) {
    throw new Error("compare --latest must be a positive integer.");
  }

  const reports = await loadSweepReports({
    rootDir: process.cwd(),
    sweepIds: positionals.length > 0 ? positionals : undefined,
    latest: positionals.length > 0 || values.suite ? undefined : (latest ?? 1),
    modelId: values.model,
  });

  const filteredReports = values.suite ? reports.filter((report) => report.suiteId === values.suite) : reports;
  const limitedReports = positionals.length > 0 || latest === undefined ? filteredReports : filteredReports.slice(0, latest);

  if (limitedReports.length === 0) {
    throw new Error("No matching sweep reports found.");
  }

  if (limitedReports.length === 1) {
    const [report] = limitedReports;
    if (!report) {
      throw new Error("No matching sweep reports found.");
    }
    printSweepReport(report);
    return;
  }

  printSweepOverview(limitedReports);
  printModelAggregateSection(limitedReports);
}

function printSweepReport(report: SweepReport): void {
  console.log(`Sweep: ${report.sweepId}`);
  console.log(`Schema: v${report.schemaVersion}`);
  console.log(`Started: ${report.startedAt}`);
  console.log(`Ended: ${report.endedAt}`);
  console.log(`Duration: ${formatDurationMs(report.durationMs)}`);
  console.log(`Model: ${report.modelId}`);
  console.log(`Provider: ${report.modelProvider}`);
  console.log(`Adapter: ${report.modelAdapter}`);
  console.log(`Reasoning effort: ${formatReasoningEffortSummary(report.reasoningEffort, report.providerReasoningEffort)}`);
  console.log(`Mode: ${report.mode}`);
  console.log(
    `Strict capability: ${report.strictCapability ? `yes (runtime retries ${report.runtimeRetryLimit})` : "no"}`,
  );
  if (report.environment?.benchmarkCommit) {
    console.log(
      `Benchmark commit: ${report.environment.benchmarkCommit}${report.environment.benchmarkDirty !== undefined ? ` (${report.environment.benchmarkDirty ? "dirty" : "clean"})` : ""}`,
    );
  }
  if (report.environment?.toolchain) {
    console.log(`Toolchain: ${formatToolchainSummary(report.environment.toolchain)}`);
  }
  if (report.suiteId) {
    console.log(
      `Suite: ${report.suiteId}${report.selection.suiteTitle ? ` (${report.selection.suiteTitle})` : ""}`,
    );
  }
  if (report.suite?.fingerprint) {
    console.log(`Suite fingerprint: ${report.suite.fingerprint}`);
  }
  if (report.resume) {
    console.log(
      `Resumed from: ${report.resume.sourceSweepId} (reran ${report.resume.rerunTargetCount}, carried ${report.resume.carriedForwardTargetCount})`,
    );
    if (report.resume.sourceBenchmarkCommit) {
      console.log(
        `Resume source benchmark: ${report.resume.sourceBenchmarkCommit}${report.resume.sourceBenchmarkDirty !== undefined ? ` (${report.resume.sourceBenchmarkDirty ? "dirty" : "clean"})` : ""}`,
      );
    }
    console.log(
      `Resume selection: runtime-excluded ${report.resume.retriedRuntimeExcluded ? "yes" : "no"}${report.resume.retryStages.length > 0 ? `, stages ${report.resume.retryStages.join(", ")}` : ""}${report.resume.retryTargetKeys.length > 0 ? `, targets ${report.resume.retryTargetKeys.join(", ")}` : ""}`,
    );
  }
  const filters = formatSelectionFilters(report);
  if (filters !== "-") {
    console.log(`Filters: ${filters}`);
  }
  console.log(`Max attempts: ${report.maxAttempts}`);
  console.log(`Warm-cache: ${report.warmed ? "yes" : "no"}`);
  console.log(
    `Summary: pairs ${report.summary.totalTargets}, scored ${report.summary.scoredTargets}, runtime-excluded ${report.summary.runtimeExcludedTargets}, scored weight ${formatWeight(report.summary.scoredWeight)}, green ${formatStageRatio(report.summary.greenTargets, report.summary.scoredTargets)}, first-pass ${formatStageRatio(report.summary.firstPassGreenTargets, report.summary.scoredTargets)}, avg attempts ${formatAttempts(report.summary.averageAttemptsUsed)}, avg ttg ${formatDurationMs(report.summary.averageTimeToGreenMs)}, capability score ${formatScore(report.summary.averageScore)}/100`,
  );
  console.log(
    `Task sources: public ${report.summary.byTaskSource.public.scoredTargets}/${report.summary.byTaskSource.public.totalTargets}, holdout ${report.summary.byTaskSource.holdout.scoredTargets}/${report.summary.byTaskSource.holdout.totalTargets}`,
  );
  console.log(`Usage: ${formatUsageSummary(report.summary.usage)}`);
  console.log(`Reliability: ${formatReliabilitySummary(report.summary.reliability)}`);
  console.log(
    `Slices: ${formatBreakdownScores(report.summary.breakdowns.byTrack, ["anchor", "native", "pinocchio"])} | ${formatBreakdownScores(report.summary.breakdowns.byInteractionMode, ["generate", "repair", "migrate"])}`,
  );
  console.log("Pairs:");
  console.log(
    formatReportRow([
      "task",
      "category",
      "difficulty",
      "weight",
      "track",
      "status",
      "scoring",
      "invokes",
      "score/100",
      "green",
      "attempts",
      "ttg",
      "build",
      "public",
      "hidden",
      "adversarial",
      "failure",
    ]),
  );
  for (const entry of report.entries) {
    console.log(
      formatReportRow([
        entry.taskId,
        entry.category,
        entry.difficulty,
        formatWeight(entry.weight),
        entry.track,
        entry.status,
        formatScoringDisposition(entry),
        formatInvocationSummary(entry),
        formatScore(entry.score),
        entry.reachedGreen ? "yes" : "no",
        `${entry.attemptCount}/${entry.maxAttempts}`,
        formatDurationMs(entry.timeToGreenMs),
        entry.buildSuccess ? "pass" : "fail",
        formatStageSummary(entry.buildSuccess, entry.tests.public.passed, entry.tests.public.total),
        formatStageSummary(entry.buildSuccess, entry.tests.hidden.passed, entry.tests.hidden.total),
        formatStageSummary(entry.buildSuccess, entry.tests.adversarial.passed, entry.tests.adversarial.total),
        entry.failureClasses.join(",") || "none",
      ]),
    );
  }
  printAggregateSection("By category", aggregateEntries(report.entries, (entry) => entry.category));
  printAggregateSection("By track", aggregateEntries(report.entries, (entry) => entry.track));
  printAggregateSection("By difficulty", aggregateEntries(report.entries, (entry) => entry.difficulty));
  printAggregateSection("By mode", aggregateEntries(report.entries, (entry) => entry.interactionMode));
  printAggregateSection("By source", aggregateEntries(report.entries, (entry) => entry.taskSource));
  printFailureSection(report.entries);
  console.log(`Report JSON: ${report.artifacts.jsonReportPath}`);
  console.log(`Report Summary: ${report.artifacts.markdownSummaryPath}`);
}

function printSweepOverview(reports: SweepReport[]): void {
  console.log("Sweep comparison:");
  console.log(
    formatOverviewRow(["sweep", "model", "effort", "suite", "strict", "pairs", "scored", "excluded", "green", "first", "attempts", "ttg", "avg/100"]),
  );
  for (const report of reports) {
    console.log(
      formatOverviewRow([
        report.sweepId,
        report.modelId,
        formatReasoningEffortCompact(report.reasoningEffort, report.providerReasoningEffort),
        report.suiteId ?? "-",
        report.strictCapability ? `yes/${report.runtimeRetryLimit}` : "no",
        String(report.summary.totalTargets),
        String(report.summary.scoredTargets),
        String(report.summary.runtimeExcludedTargets),
        formatStageRatio(report.summary.greenTargets, report.summary.scoredTargets),
        formatStageRatio(report.summary.firstPassGreenTargets, report.summary.scoredTargets),
        formatAttempts(report.summary.averageAttemptsUsed),
        formatDurationMs(report.summary.averageTimeToGreenMs),
        formatScore(report.summary.averageScore),
      ]),
    );
  }
}

function formatReportRow(values: string[]): string {
  const widths = [22, 14, 10, 8, 10, 10, 20, 10, 10, 7, 10, 8, 8, 10, 10, 13, 24];
  return formatRow(values, widths);
}

async function removePrefixedEntries(rootDir: string, prefixes: readonly string[]): Promise<number> {
  try {
    const entries = await readdir(rootDir, { encoding: "utf8", withFileTypes: true });
    let removedCount = 0;
    for (const entry of entries) {
      if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) {
        continue;
      }

      await rm(path.join(rootDir, entry.name), { recursive: true, force: true });
      removedCount += 1;
    }

    return removedCount;
  } catch (error) {
    if (isMissingPathError(error)) {
      return 0;
    }

    throw error;
  }
}

async function clearDirectoryContents(rootDir: string, preservedEntries: ReadonlySet<string>): Promise<number> {
  try {
    const entries = await readdir(rootDir, { encoding: "utf8", withFileTypes: true });
    let removedCount = 0;
    for (const entry of entries) {
      if (preservedEntries.has(entry.name)) {
        continue;
      }

      await rm(path.join(rootDir, entry.name), { recursive: true, force: true });
      removedCount += 1;
    }

    return removedCount;
  } catch (error) {
    if (isMissingPathError(error)) {
      return 0;
    }

    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function pluralize(count: number, singularSuffix: string, pluralSuffix: string): string {
  return count === 1 ? singularSuffix : pluralSuffix;
}

function formatSelectionFilters(report: SweepReport): string {
  const filters = [
    report.selection.track ? `track=${report.selection.track}` : undefined,
    report.selection.taskId ? `task=${report.selection.taskId}` : undefined,
    report.selection.difficulty ? `difficulty=${report.selection.difficulty}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return filters.length > 0 ? filters.join(", ") : "-";
}

function formatOverviewRow(values: string[]): string {
  const widths = [32, 20, 10, 20, 8, 6, 8, 9, 8, 8, 9, 8, 8];
  return formatRow(values, widths);
}

function formatAggregateRow(values: string[]): string {
  const widths = [18, 6, 7, 9, 8, 8, 9, 8, 8, 10, 10, 13, 10];
  return formatRow(values, widths);
}

function formatFailureRow(values: string[]): string {
  const widths = [24, 8, 48];
  return formatRow(values, widths);
}

function formatRow(values: string[], widths: number[]): string {
  return values
    .map((value, index) => value.padEnd(widths[index] ?? value.length))
    .join(" ")
    .trimEnd();
}

function formatStageRatio(passed: number, total: number): string {
  return `${passed}/${total}`;
}

function formatStageSummary(buildSuccess: boolean, passed: number, total: number): string {
  if (!buildSuccess && total === 0) {
    return "skipped";
  }

  return formatStageRatio(passed, total);
}

function formatScore(value: number): string {
  return (value * 100).toFixed(2);
}

function formatWeight(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatAttempts(value: number): string {
  return value.toFixed(2);
}

function formatDurationMs(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }

  return `${(value / 1000).toFixed(1)}s`;
}

function formatToolchainSummary(toolchain: Record<string, string | null>): string {
  return Object.entries(toolchain)
    .map(([key, value]) => `${key}=${value ?? "unknown"}`)
    .sort()
    .join(", ");
}

function formatUsageSummary(summary: SweepReport["summary"]["usage"]): string {
  const parts = [
    `latency ${formatDurationMs(summary.latencyMs)}`,
    `avg latency ${formatDurationMs(summary.averageLatencyMs)}`,
    summary.totalTokens !== undefined ? `tokens ${Math.round(summary.totalTokens)}` : undefined,
    summary.averageTotalTokensPerEntry !== undefined
      ? `avg tokens/entry ${Math.round(summary.averageTotalTokensPerEntry)}`
      : undefined,
    summary.estimatedCostUsd !== undefined ? `cost ${formatUsd(summary.estimatedCostUsd)}` : undefined,
    `usage entries ${summary.entriesWithUsage}`,
  ].filter((value): value is string => value !== undefined);

  return parts.join(", ");
}

function formatReliabilitySummary(summary: SweepReport["summary"]["reliability"]): string {
  return [
    summary.fullSweepCompleted ? "full sweep complete" : "runtime exclusions present",
    `invokes ${summary.totalInvocations}`,
    `avg invokes ${formatAttempts(summary.averageInvocationAttempts)}`,
    `retry-free ${formatPercent(summary.retryFreeTargetRate)}`,
    `scored ${formatPercent(summary.scoredTargetRate)}`,
    `green ${formatPercent(summary.greenTargetRate)}`,
    `first-pass ${formatPercent(summary.firstPassGreenTargetRate)}`,
  ].join(", ");
}

function formatBreakdownScores(
  breakdown: Record<string, { averageScore: number }>,
  orderedKeys: string[],
): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const key of orderedKeys) {
    const summary = breakdown[key];
    if (!summary) {
      continue;
    }

    parts.push(`${key} ${formatScore(summary.averageScore)}/100`);
    seen.add(key);
  }

  for (const key of Object.keys(breakdown).sort()) {
    if (seen.has(key)) {
      continue;
    }

    const summary = breakdown[key];
    if (!summary) {
      continue;
    }

    parts.push(`${key} ${formatScore(summary.averageScore)}/100`);
  }

  return parts.length > 0 ? parts.join(", ") : "-";
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatInvocationSummary(entry: Pick<SweepEntry, "invocationAttempts" | "runtimeRetriesUsed">): string {
  if (entry.runtimeRetriesUsed === 0) {
    return String(entry.invocationAttempts);
  }

  return `${entry.invocationAttempts} (+${entry.runtimeRetriesUsed})`;
}

function aggregateEntries(entries: SweepEntry[], keyFn: (entry: SweepEntry) => string): Array<{ key: string; entries: SweepEntry[] }> {
  const buckets = new Map<string, SweepEntry[]>();
  for (const entry of entries) {
    const key = keyFn(entry);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      buckets.set(key, [entry]);
    }
  }

  return [...buckets.entries()]
    .map(([key, bucketEntries]) => ({ key, entries: bucketEntries }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function printAggregateSection(title: string, aggregates: Array<{ key: string; entries: SweepEntry[] }>): void {
  console.log(title + ":");
  console.log(
    formatAggregateRow([
      "group",
      "pairs",
      "scored",
      "excluded",
      "weight",
      "green",
      "first",
      "attempts",
      "ttg",
      "build",
      "public",
      "hidden",
      "adversarial",
      "avg/100",
    ]),
  );
  for (const aggregate of aggregates) {
    const summary = summarizeEntries(aggregate.entries);
    console.log(
      formatAggregateRow([
        aggregate.key,
        String(summary.pairs),
        String(summary.scoredTargets),
        String(summary.runtimeExcludedTargets),
        formatWeight(summary.totalWeight),
        formatStageRatio(summary.greenTargets, summary.scoredTargets),
        formatStageRatio(summary.firstPassGreenTargets, summary.scoredTargets),
        formatAttempts(summary.averageAttemptsUsed),
        formatDurationMs(summary.averageTimeToGreenMs),
        formatStageRatio(summary.buildPassed, summary.scoredTargets),
        formatStageRatio(summary.publicPassed, summary.publicTotal),
        formatStageRatio(summary.hiddenPassed, summary.hiddenTotal),
        formatStageRatio(summary.adversarialPassed, summary.adversarialTotal),
        formatScore(summary.averageScore),
      ]),
    );
  }
}

function printFailureSection(entries: SweepEntry[]): void {
  const failureMap = new Map<string, Set<string>>();
  for (const entry of entries.filter((candidate) => candidate.benchmarkEligible)) {
    for (const failureClass of entry.failureClasses) {
      const bucket = failureMap.get(failureClass) ?? new Set<string>();
      bucket.add(`${entry.taskId}/${entry.track}`);
      failureMap.set(failureClass, bucket);
    }
  }

  console.log("Failure hotspots:");
  console.log(formatFailureRow(["class", "count", "pairs"]));
  if (failureMap.size === 0) {
    console.log(formatFailureRow(["none", "0", "-"]));
    return;
  }

  for (const [failureClass, pairs] of [...failureMap.entries()].sort((left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]))) {
    console.log(formatFailureRow([failureClass, String(pairs.size), [...pairs].sort().join(", ")]));
  }
}

function printModelAggregateSection(reports: SweepReport[]): void {
  const byModel = new Map<string, SweepEntry[]>();
  for (const report of reports) {
    const aggregateKey = `${report.modelId} [${formatReasoningEffortCompact(report.reasoningEffort, report.providerReasoningEffort)}]`;
    const bucket = byModel.get(aggregateKey) ?? [];
    bucket.push(...report.entries);
    byModel.set(aggregateKey, bucket);
  }

  console.log("Model aggregates:");
  console.log(
    formatAggregateRow([
      "group",
      "pairs",
      "scored",
      "excluded",
      "weight",
      "green",
      "first",
      "attempts",
      "ttg",
      "build",
      "public",
      "hidden",
      "adversarial",
      "avg/100",
    ]),
  );
  for (const [modelId, entries] of [...byModel.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const summary = summarizeEntries(entries);
    console.log(
      formatAggregateRow([
        modelId,
        String(summary.pairs),
        String(summary.scoredTargets),
        String(summary.runtimeExcludedTargets),
        formatWeight(summary.totalWeight),
        formatStageRatio(summary.greenTargets, summary.scoredTargets),
        formatStageRatio(summary.firstPassGreenTargets, summary.scoredTargets),
        formatAttempts(summary.averageAttemptsUsed),
        formatDurationMs(summary.averageTimeToGreenMs),
        formatStageRatio(summary.buildPassed, summary.scoredTargets),
        formatStageRatio(summary.publicPassed, summary.publicTotal),
        formatStageRatio(summary.hiddenPassed, summary.hiddenTotal),
        formatStageRatio(summary.adversarialPassed, summary.adversarialTotal),
        formatScore(summary.averageScore),
      ]),
    );
  }
}

function summarizeEntries(entries: SweepEntry[]): {
  pairs: number;
  totalWeight: number;
  scoredTargets: number;
  runtimeExcludedTargets: number;
  greenTargets: number;
  firstPassGreenTargets: number;
  averageAttemptsUsed: number;
  averageTimeToGreenMs?: number;
  buildPassed: number;
  publicPassed: number;
  publicTotal: number;
  hiddenPassed: number;
  hiddenTotal: number;
  adversarialPassed: number;
  adversarialTotal: number;
  averageScore: number;
} {
  const scoredEntries = entries.filter((entry) => entry.benchmarkEligible);
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const totalScore = scoredEntries.reduce((sum, entry) => sum + entry.score * entry.weight, 0);
  const greenEntries = scoredEntries.filter((entry) => entry.reachedGreen);
  const greenWeight = greenEntries.reduce((sum, entry) => sum + entry.weight, 0);
  const attemptsWeighted = scoredEntries.reduce((sum, entry) => sum + entry.attemptCount * entry.weight, 0);
  const timeToGreenWeighted = greenEntries.reduce(
    (sum, entry) => sum + (entry.timeToGreenMs ?? 0) * entry.weight,
    0,
  );
  const scoredWeight = scoredEntries.reduce((sum, entry) => sum + entry.weight, 0);
  return {
    pairs: entries.length,
    totalWeight,
    scoredTargets: scoredEntries.length,
    runtimeExcludedTargets: entries.length - scoredEntries.length,
    greenTargets: greenEntries.length,
    firstPassGreenTargets: scoredEntries.filter((entry) => entry.firstPassGreen).length,
    averageAttemptsUsed: scoredWeight === 0 ? 0 : attemptsWeighted / scoredWeight,
    averageTimeToGreenMs: greenWeight === 0 ? undefined : timeToGreenWeighted / greenWeight,
    buildPassed: scoredEntries.filter((entry) => entry.buildSuccess).length,
    publicPassed: scoredEntries.reduce((sum, entry) => sum + entry.tests.public.passed, 0),
    publicTotal: scoredEntries.reduce((sum, entry) => sum + entry.tests.public.total, 0),
    hiddenPassed: scoredEntries.reduce((sum, entry) => sum + entry.tests.hidden.passed, 0),
    hiddenTotal: scoredEntries.reduce((sum, entry) => sum + entry.tests.hidden.total, 0),
    adversarialPassed: scoredEntries.reduce((sum, entry) => sum + entry.tests.adversarial.passed, 0),
    adversarialTotal: scoredEntries.reduce((sum, entry) => sum + entry.tests.adversarial.total, 0),
    averageScore: scoredWeight === 0 ? 0 : totalScore / scoredWeight,
  };
}

function formatScoringDisposition(entry: Pick<SweepEntry, "benchmarkEligible" | "errorStage">): string {
  if (entry.benchmarkEligible) {
    return "scored";
  }

  return `excluded:${entry.errorStage ?? "runtime"}`;
}

function printHelp(): void {
  console.log(`Usage:
  benchmark validate
  benchmark list tasks
  benchmark list models
  benchmark list suites
  benchmark run --model <id> --track <track> --task <task> [--mode offline|retrieval] [--reasoning-effort default|low|medium|high|xhigh] [--max-attempts <n>] [--strict-capability] [--runtime-retries <n>]
  benchmark run-all --model <id> [--mode offline|retrieval] [--suite <suite>] [--track <track>] [--task <task>] [--difficulty easy|medium|hard] [--repeats <n>] [--reasoning-effort default|low|medium|high|xhigh] [--max-attempts <n>] [--strict-capability] [--runtime-retries <n>] [--require-full-sweep] [--warm-cache]
  benchmark resume-sweep [<sweep-id> | --latest] [--retry-benchmark-faults] [--retry-stage <stage[,stage...]>] [--retry-target <task/track[,task/track...]>] [--skip-runtime-excluded] [--require-full-sweep] [--warm-cache]
  benchmark baseline <reference|insecure> --track <track> --task <task>
  benchmark warm-cache --track <track> --task <task>
  benchmark clean [--tooling] [--results] [--all]
  benchmark compare [<sweep-id> ...] [--latest <n>] [--model <id>] [--suite <suite>]
  benchmark self-check [--track <track>] [--task <task>] [--difficulty <level>] [--suite <suite>]`);
}

const DEFAULT_BENCHMARK_RETRY_STAGES = [
  "artifact_persist",
  "model_output_validation",
  "workspace_apply",
] as const;

async function resolveResumeSweepId(args: {
  rootDir: string;
  explicitSweepId?: string;
  useLatest: boolean;
}): Promise<string> {
  if (args.explicitSweepId) {
    return args.explicitSweepId;
  }

  if (!args.useLatest) {
    throw new Error("resume-sweep requires a sweep ID or --latest.");
  }

  const [latestReport] = await loadSweepReports({
    rootDir: args.rootDir,
    latest: 1,
  });

  if (!latestReport) {
    throw new Error("No saved sweep reports found to resume.");
  }

  return latestReport.sweepId;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function mergeUniqueStages(...groups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  return Array.from(new Set(groups.flat().map((stage) => stage.trim()).filter((stage) => stage.length > 0)));
}

function parseRetryTargetKeys(value: string | undefined): string[] {
  return parseCsvList(value).map((target) => {
    const slashIndex = target.lastIndexOf("/");
    if (slashIndex <= 0 || slashIndex === target.length - 1) {
      throw new Error(`Invalid --retry-target value: ${target}. Expected task/track.`);
    }

    const taskId = target.slice(0, slashIndex).trim();
    const track = target.slice(slashIndex + 1).trim();
    if (!taskId || !isValidTrackId(track)) {
      throw new Error(`Invalid --retry-target value: ${target}. Expected task/track with track anchor|native|pinocchio.`);
    }

    return `${taskId}/${track}`;
  });
}

function parseReasoningEffortOption(value: string | undefined): BenchmarkReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "max") {
    return "xhigh";
  }

  if (
    normalized === "default"
    || normalized === "low"
    || normalized === "medium"
    || normalized === "high"
    || normalized === "xhigh"
  ) {
    return normalized;
  }

  throw new Error(
    `Invalid --reasoning-effort value: ${value}. Expected default, low, medium, high, xhigh, or max.`,
  );
}

function formatReasoningEffortSummary(
  reasoningEffort: BenchmarkReasoningEffort,
  providerReasoningEffort?: string,
): string {
  if (!providerReasoningEffort || providerReasoningEffort === reasoningEffort) {
    return reasoningEffort;
  }

  return `${reasoningEffort} (provider ${providerReasoningEffort})`;
}

function formatReasoningEffortCompact(
  reasoningEffort: BenchmarkReasoningEffort,
  providerReasoningEffort?: string,
): string {
  if (!providerReasoningEffort || providerReasoningEffort === reasoningEffort) {
    return reasoningEffort;
  }

  return `${reasoningEffort}/${providerReasoningEffort}`;
}

function isValidTrackId(value: string): value is "anchor" | "native" | "pinocchio" {
  return value === "anchor" || value === "native" || value === "pinocchio";
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
