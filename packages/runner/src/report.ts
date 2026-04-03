import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  discoverTasks,
  type Difficulty,
  type InteractionMode,
  type InvocationMode,
  type TrackId,
} from "../../core/src/index.js";
import {
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile,
  writeTextFile,
} from "../../shared/src/index.js";
import { runBenchmark, type BenchmarkExecution, type AttemptResult } from "./run.js";
import { loadBenchmarkSuite, type BenchmarkSuite, type BenchmarkSuiteTarget } from "./suites.js";
import { warmTaskCache } from "./warm.js";

export interface BenchmarkTarget {
  taskId: string;
  track: TrackId;
  category: string;
  difficulty: Difficulty;
  interactionMode: InteractionMode;
  title: string;
  weight: number;
  taskSource: "public" | "holdout";
}

export interface SweepEntry {
  taskId: string;
  track: TrackId;
  category: string;
  difficulty: Difficulty;
  interactionMode: InteractionMode;
  title: string;
  weight: number;
  taskSource: "public" | "holdout";
  runId: string;
  attemptId: string;
  status: AttemptResult["status"];
  errorStage?: string;
  score: number;
  buildSuccess: boolean;
  tests: AttemptResult["tests"];
  failureClasses: string[];
  benchmarkEligible: boolean;
  scoringDisposition: "scored" | "excluded_runtime";
  invocationAttempts: number;
  runtimeRetriesUsed: number;
  resultPath: string;
  attemptDir: string;
  attemptCount: number;
  maxAttempts: number;
  reachedGreen: boolean;
  firstPassGreen: boolean;
  greenAttemptNumber?: number;
  timeToGreenMs?: number;
  totalDurationMs: number;
}

export interface SweepTaskSourceSummary {
  totalTargets: number;
  totalWeight: number;
  scoredTargets: number;
  scoredWeight: number;
  runtimeExcludedTargets: number;
  runtimeExcludedWeight: number;
}

export interface SweepSummary {
  totalTargets: number;
  totalWeight: number;
  scoredTargets: number;
  scoredWeight: number;
  runtimeExcludedTargets: number;
  runtimeExcludedWeight: number;
  completedTargets: number;
  failedTargets: number;
  buildPassedTargets: number;
  greenTargets: number;
  firstPassGreenTargets: number;
  averageScore: number;
  averageAttemptsUsed: number;
  averageTimeToGreenMs?: number;
  byTaskSource: {
    public: SweepTaskSourceSummary;
    holdout: SweepTaskSourceSummary;
  };
}

export interface SweepSelection {
  suiteId?: string;
  suiteTitle?: string;
  track?: TrackId;
  taskId?: string;
  difficulty?: Difficulty;
}

export interface SweepArtifacts {
  jsonReportPath: string;
  markdownSummaryPath: string;
}

export interface SweepReport {
  sweepId: string;
  createdAt: string;
  modelId: string;
  modelProvider: string;
  mode: InvocationMode;
  warmed: boolean;
  strictCapability: boolean;
  runtimeRetryLimit: number;
  suiteId?: string;
  selection: SweepSelection;
  maxAttempts: number;
  artifacts: SweepArtifacts;
  summary: SweepSummary;
  entries: SweepEntry[];
}

interface RunBenchmarkSweepArgs {
  rootDir: string;
  modelId: string;
  mode?: InvocationMode;
  strictCapability?: boolean;
  runtimeRetryLimit?: number;
  onProgress?: (message: string) => void;
  suiteId?: string;
  track?: TrackId;
  taskId?: string;
  difficulty?: Difficulty;
  warmCache?: boolean;
  maxAttempts?: number;
}

interface LoadSweepReportsArgs {
  rootDir: string;
  sweepIds?: string[];
  latest?: number;
  modelId?: string;
}

export async function listBenchmarkTargets(args: {
  rootDir: string;
  suiteId?: string;
  track?: TrackId;
  taskId?: string;
  difficulty?: Difficulty;
}): Promise<BenchmarkTarget[]> {
  const tasks = await discoverTasks(args.rootDir);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));

  if (args.suiteId) {
    const suite = await loadBenchmarkSuite(args.rootDir, args.suiteId);
    return suite.targets.map((target) => {
      const task = taskMap.get(target.taskId);
      if (!task) {
        throw new Error(`Suite "${suite.id}" references unknown task "${target.taskId}".`);
      }

      if (!task.spec.supportedTracks.includes(target.track) || !task.tracks[target.track]) {
        throw new Error(`Suite "${suite.id}" references unavailable pair "${target.taskId}/${target.track}".`);
      }

      const interactionMode = task.spec.supportedModes[0] ?? "generate";
      return {
        taskId: task.id,
        track: target.track,
        category: task.spec.category,
        difficulty: task.spec.difficulty,
        interactionMode,
        title: task.spec.title,
        weight: normalizeTargetWeight(computeSuiteTargetWeight(suite, target, {
          category: task.spec.category,
          difficulty: task.spec.difficulty,
          interactionMode,
        })),
        taskSource: classifyTaskSource(args.rootDir, task.rootDir),
      };
    });
  }

  const targets: BenchmarkTarget[] = [];

  for (const task of tasks) {
    if (args.taskId && task.id !== args.taskId) {
      continue;
    }

    if (args.difficulty && task.spec.difficulty !== args.difficulty) {
      continue;
    }

    for (const supportedTrack of task.spec.supportedTracks) {
      if (args.track && supportedTrack !== args.track) {
        continue;
      }

      if (!task.tracks[supportedTrack]) {
        continue;
      }

      targets.push({
        taskId: task.id,
        track: supportedTrack,
        category: task.spec.category,
        difficulty: task.spec.difficulty,
        interactionMode: task.spec.supportedModes[0] ?? "generate",
        title: task.spec.title,
        weight: defaultDifficultyWeight(task.spec.difficulty),
        taskSource: classifyTaskSource(args.rootDir, task.rootDir),
      });
    }
  }

  return targets.sort((left, right) => {
    const taskCompare = left.taskId.localeCompare(right.taskId);
    if (taskCompare !== 0) {
      return taskCompare;
    }

    return left.track.localeCompare(right.track);
  });
}

export async function runBenchmarkSweep(args: RunBenchmarkSweepArgs): Promise<SweepReport> {
  const mode = args.mode ?? "offline";
  const maxAttempts = args.maxAttempts ?? 1;
  const strictCapability = args.strictCapability ?? false;
  const runtimeRetryLimit = strictCapability ? Math.max(args.runtimeRetryLimit ?? 2, 0) : 0;
  const suite = args.suiteId ? await loadBenchmarkSuite(args.rootDir, args.suiteId) : undefined;
  const targets = await listBenchmarkTargets({
    rootDir: args.rootDir,
    suiteId: args.suiteId,
    track: args.track,
    taskId: args.taskId,
    difficulty: args.difficulty,
  });

  if (targets.length === 0) {
    throw new Error("No matching task/track pairs found for run-all.");
  }

  const sweepId = createSweepId();
  const entries: SweepEntry[] = [];

  for (const [targetIndex, target] of targets.entries()) {
    const progressPrefix = `[${targetIndex + 1}/${targets.length}] ${target.taskId}/${target.track}`;
    args.onProgress?.(`${progressPrefix}: target started`);
    if (args.warmCache) {
      args.onProgress?.(`${progressPrefix}: warm-cache started`);
      await warmTaskCache({
        rootDir: args.rootDir,
        taskId: target.taskId,
        track: target.track,
      });
      args.onProgress?.(`${progressPrefix}: warm-cache finished`);
    }

    const execution = await runBenchmark({
      rootDir: args.rootDir,
      taskId: target.taskId,
      track: target.track,
      modelId: args.modelId,
      mode,
      maxAttempts,
      strictCapability,
      runtimeRetryLimit,
      onProgress: args.onProgress,
      progressPrefix,
    });

    const entry = toSweepEntry(target, args.rootDir, execution);
    entries.push(entry);
    args.onProgress?.(
      `${progressPrefix}: target finished (${entry.scoringDisposition === "scored" ? `${formatScore100(entry.score)}/100` : `excluded:${entry.errorStage ?? "runtime"}`})`,
    );
  }

  const report: SweepReport = {
    sweepId,
    createdAt: new Date().toISOString(),
    modelId: args.modelId,
    modelProvider: inferModelProvider(args.modelId),
    mode,
    warmed: args.warmCache ?? false,
    strictCapability,
    runtimeRetryLimit,
    suiteId: args.suiteId,
    selection: {
      suiteId: args.suiteId,
      suiteTitle: suite?.title,
      track: args.track,
      taskId: args.taskId,
      difficulty: args.difficulty,
    },
    maxAttempts,
    artifacts: buildSweepArtifacts(sweepId),
    summary: computeSweepSummary(entries),
    entries,
  };

  await persistSweepReport(args.rootDir, report);
  return report;
}

export async function loadSweepReports(args: LoadSweepReportsArgs): Promise<SweepReport[]> {
  const sweepsDir = path.join(args.rootDir, "results", "sweeps");
  if (!(await pathExists(sweepsDir))) {
    return [];
  }

  const fileNames = await readdir(sweepsDir);
  const jsonFiles = fileNames.filter((fileName) => fileName.endsWith(".json")).sort().reverse();

  let selectedFiles = jsonFiles;
  if (args.sweepIds && args.sweepIds.length > 0) {
    const wanted = new Set(args.sweepIds.map((sweepId) => `${sweepId}.json`));
    selectedFiles = jsonFiles.filter((fileName) => wanted.has(fileName));
  }

  const reports: SweepReport[] = [];
  for (const fileName of selectedFiles) {
    const report = await normalizeSweepReport(
      args.rootDir,
      await readJsonFile<SweepReport>(path.join(sweepsDir, fileName)),
    );
    if (args.modelId && report.modelId !== args.modelId) {
      continue;
    }

    reports.push(report);
    if (args.latest && reports.length >= args.latest) {
      break;
    }
  }

  return reports;
}

function toSweepEntry(
  target: BenchmarkTarget,
  rootDir: string,
  execution: BenchmarkExecution,
): SweepEntry {
  return {
    taskId: target.taskId,
    track: target.track,
    category: target.category,
    difficulty: target.difficulty,
    interactionMode: target.interactionMode,
    title: target.title,
    weight: target.weight,
    taskSource: target.taskSource,
    runId: execution.result.runId,
    attemptId: execution.result.attemptId,
    status: execution.result.status,
    errorStage: execution.result.error?.stage,
    score: execution.result.score.total,
    buildSuccess: execution.result.build.success,
    tests: execution.result.tests,
    failureClasses: execution.result.failureClasses,
    benchmarkEligible: isBenchmarkEligible(execution.result),
    scoringDisposition: isBenchmarkEligible(execution.result) ? "scored" : "excluded_runtime",
    invocationAttempts: execution.result.invocationAttempts,
    runtimeRetriesUsed: execution.result.runtimeRetriesUsed,
    resultPath: path.relative(rootDir, path.join(execution.attemptDir, "result.json")),
    attemptDir: path.relative(rootDir, execution.attemptDir),
    attemptCount: execution.run.attemptCount,
    maxAttempts: execution.run.maxAttempts,
    reachedGreen: execution.run.reachedGreen,
    firstPassGreen: execution.run.firstPassGreen,
    greenAttemptNumber: execution.run.greenAttemptNumber,
    timeToGreenMs: execution.run.timeToGreenMs,
    totalDurationMs: execution.run.totalDurationMs,
  };
}

function computeSweepSummary(entries: SweepEntry[]): SweepSummary {
  const scoredEntries = entries.filter((entry) => entry.benchmarkEligible);
  const runtimeExcludedEntries = entries.filter((entry) => !entry.benchmarkEligible);
  const completedTargets = scoredEntries.filter((entry) => entry.status === "completed").length;
  const buildPassedTargets = scoredEntries.filter((entry) => entry.buildSuccess).length;
  const totalWeight = entries.reduce((sum, entry) => sum + normalizeTargetWeight(entry.weight), 0);
  const scoredWeight = scoredEntries.reduce(
    (sum, entry) => sum + normalizeTargetWeight(entry.weight),
    0,
  );
  const runtimeExcludedWeight = runtimeExcludedEntries.reduce(
    (sum, entry) => sum + normalizeTargetWeight(entry.weight),
    0,
  );
  const totalScore = scoredEntries.reduce(
    (sum, entry) => sum + entry.score * normalizeTargetWeight(entry.weight),
    0,
  );

  return {
    totalTargets: entries.length,
    totalWeight: roundWeight(totalWeight),
    scoredTargets: scoredEntries.length,
    scoredWeight: roundWeight(scoredWeight),
    runtimeExcludedTargets: runtimeExcludedEntries.length,
    runtimeExcludedWeight: roundWeight(runtimeExcludedWeight),
    completedTargets,
    failedTargets: scoredEntries.length - completedTargets,
    buildPassedTargets,
    greenTargets: scoredEntries.filter((entry) => entry.reachedGreen).length,
    firstPassGreenTargets: scoredEntries.filter((entry) => entry.firstPassGreen).length,
    averageScore: scoredWeight === 0 ? 0 : roundScore(totalScore / scoredWeight),
    averageAttemptsUsed: roundAttempts(weightedAverage(scoredEntries, (entry) => entry.attemptCount)),
    averageTimeToGreenMs: weightedAverage(
      scoredEntries,
      (entry) => entry.timeToGreenMs,
      (entry) => entry.reachedGreen,
    ),
    byTaskSource: {
      public: computeTaskSourceSummary(entries, "public"),
      holdout: computeTaskSourceSummary(entries, "holdout"),
    },
  };
}

async function persistSweepReport(rootDir: string, report: SweepReport): Promise<void> {
  const normalizedReport: SweepReport = {
    ...report,
    modelProvider: report.modelProvider ?? inferModelProvider(report.modelId),
    strictCapability: report.strictCapability ?? false,
    runtimeRetryLimit: report.runtimeRetryLimit ?? 0,
    artifacts: report.artifacts ?? buildSweepArtifacts(report.sweepId),
  };

  const sweepsDir = path.join(rootDir, "results", "sweeps");
  await ensureDir(sweepsDir);
  await writeJsonFile(path.join(rootDir, normalizedReport.artifacts.jsonReportPath), normalizedReport);
  await writeTextFile(
    path.join(rootDir, normalizedReport.artifacts.markdownSummaryPath),
    renderSweepMarkdownSummary(normalizedReport),
  );
}

function createSweepId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
}

async function normalizeSweepReport(rootDir: string, report: SweepReport): Promise<SweepReport> {
  const tasks = await discoverTasks(rootDir);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const suiteId = report.selection?.suiteId ?? report.suiteId;
  const suite = suiteId ? await loadBenchmarkSuite(rootDir, suiteId).catch(() => undefined) : undefined;

  const entries = await Promise.all(report.entries.map(async (entry) => {
    const task = taskMap.get(entry.taskId);
    const interactionMode = entry.interactionMode ?? task?.spec.supportedModes[0] ?? "generate";
    const taskSource = entry.taskSource ?? classifyTaskSource(rootDir, task?.rootDir);
    const suiteTarget = suite?.targets.find(
      (target) => target.taskId === entry.taskId && target.track === entry.track,
    );

    const weight =
      entry.weight ??
      (suite && suiteTarget
        ? computeSuiteTargetWeight(suite, suiteTarget, {
            category: entry.category,
            difficulty: entry.difficulty,
            interactionMode,
          })
        : defaultDifficultyWeight(entry.difficulty));

    const reachedGreen = entry.reachedGreen ?? inferGreenFromEntry(entry);
    const greenAttemptNumber = entry.greenAttemptNumber ?? (reachedGreen ? 1 : undefined);
    const attemptCount = entry.attemptCount ?? 1;
    const storedAttempt = await loadStoredAttemptResult(rootDir, entry.resultPath);
    const errorStage = entry.errorStage ?? storedAttempt?.error?.stage;
    const benchmarkEligible = entry.benchmarkEligible ?? isBenchmarkEligibleFromStage(errorStage);

    return {
      ...entry,
      interactionMode,
      weight: normalizeTargetWeight(weight),
      taskSource,
      errorStage,
      benchmarkEligible,
      scoringDisposition:
        entry.scoringDisposition ?? (benchmarkEligible ? "scored" : "excluded_runtime"),
      invocationAttempts: entry.invocationAttempts ?? 1,
      runtimeRetriesUsed: entry.runtimeRetriesUsed ?? Math.max((entry.invocationAttempts ?? 1) - 1, 0),
      attemptCount,
      maxAttempts: entry.maxAttempts ?? attemptCount,
      reachedGreen,
      firstPassGreen: entry.firstPassGreen ?? (reachedGreen && attemptCount === 1),
      greenAttemptNumber,
      timeToGreenMs: entry.timeToGreenMs,
      totalDurationMs: entry.totalDurationMs ?? entry.timeToGreenMs ?? 0,
    };
  }));

  return {
    ...report,
    modelProvider: report.modelProvider ?? inferModelProvider(report.modelId),
    strictCapability: report.strictCapability ?? false,
    runtimeRetryLimit: report.runtimeRetryLimit ?? 0,
    suiteId,
    selection: {
      suiteId,
      suiteTitle: report.selection?.suiteTitle ?? suite?.title,
      track: report.selection?.track,
      taskId: report.selection?.taskId,
      difficulty: report.selection?.difficulty,
    },
    artifacts: report.artifacts ?? buildSweepArtifacts(report.sweepId),
    maxAttempts: report.maxAttempts ?? Math.max(...entries.map((entry) => entry.maxAttempts), 1),
    entries,
    summary: computeSweepSummary(entries),
  };
}

function computeSuiteTargetWeight(
  suite: BenchmarkSuite,
  target: BenchmarkSuiteTarget,
  context: {
    category: string;
    difficulty: Difficulty;
    interactionMode: InteractionMode;
  },
): number {
  if (target.weight !== undefined) {
    return target.weight;
  }

  const base = suite.weightRules?.base ?? 1;
  const difficultyWeight = suite.weightRules?.difficulty?.[context.difficulty] ?? defaultDifficultyWeight(context.difficulty);
  const interactionModeWeight = suite.weightRules?.interactionMode?.[context.interactionMode] ?? 1;
  const trackWeight = suite.weightRules?.track?.[target.track] ?? 1;
  const categoryWeight = suite.weightRules?.category?.[context.category] ?? 1;

  return base * difficultyWeight * interactionModeWeight * trackWeight * categoryWeight;
}

function computeTaskSourceSummary(
  entries: SweepEntry[],
  taskSource: "public" | "holdout",
): SweepTaskSourceSummary {
  const sourceEntries = entries.filter((entry) => entry.taskSource === taskSource);
  const scoredEntries = sourceEntries.filter((entry) => entry.benchmarkEligible);
  const runtimeExcludedEntries = sourceEntries.filter((entry) => !entry.benchmarkEligible);

  return {
    totalTargets: sourceEntries.length,
    totalWeight: roundWeight(sourceEntries.reduce((sum, entry) => sum + normalizeTargetWeight(entry.weight), 0)),
    scoredTargets: scoredEntries.length,
    scoredWeight: roundWeight(scoredEntries.reduce((sum, entry) => sum + normalizeTargetWeight(entry.weight), 0)),
    runtimeExcludedTargets: runtimeExcludedEntries.length,
    runtimeExcludedWeight: roundWeight(
      runtimeExcludedEntries.reduce((sum, entry) => sum + normalizeTargetWeight(entry.weight), 0),
    ),
  };
}

function defaultDifficultyWeight(difficulty: Difficulty): number {
  switch (difficulty) {
    case "easy":
      return 1;
    case "medium":
      return 2;
    case "hard":
      return 3;
    default:
      return 1;
  }
}

function weightedAverage(
  entries: SweepEntry[],
  pick: (entry: SweepEntry) => number | undefined,
  include: (entry: SweepEntry) => boolean = () => true,
): number | undefined {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const entry of entries) {
    if (!include(entry)) {
      continue;
    }

    const value = pick(entry);
    if (value === undefined) {
      continue;
    }

    const weight = normalizeTargetWeight(entry.weight);
    totalWeight += weight;
    weightedSum += value * weight;
  }

  if (totalWeight === 0) {
    return undefined;
  }

  return Number((weightedSum / totalWeight).toFixed(2));
}

function inferGreenFromEntry(entry: Pick<SweepEntry, "status" | "score">): boolean {
  return entry.status === "completed" && entry.score >= 0.9999;
}

function isBenchmarkEligible(result: AttemptResult): boolean {
  return isBenchmarkEligibleFromStage(result.error?.stage);
}

function isBenchmarkEligibleFromStage(stage: string | undefined): boolean {
  return stage !== "model_invoke";
}

function normalizeTargetWeight(weight: number): number {
  return roundWeight(weight);
}

function roundScore(value: number): number {
  return Number(value.toFixed(4));
}

function roundWeight(value: number): number {
  return Number(value.toFixed(2));
}

function roundAttempts(value: number | undefined): number {
  return Number((value ?? 0).toFixed(2));
}

async function loadStoredAttemptResult(
  rootDir: string,
  resultPath: string | undefined,
): Promise<AttemptResult | undefined> {
  if (!resultPath) {
    return undefined;
  }

  const absolutePath = path.join(rootDir, resultPath);
  if (!(await pathExists(absolutePath))) {
    return undefined;
  }

  try {
    return await readJsonFile<AttemptResult>(absolutePath);
  } catch {
    return undefined;
  }
}

function buildSweepArtifacts(sweepId: string): SweepArtifacts {
  return {
    jsonReportPath: toSweepArtifactPath(sweepId, "json"),
    markdownSummaryPath: toSweepArtifactPath(sweepId, "md"),
  };
}

function toSweepArtifactPath(sweepId: string, extension: "json" | "md"): string {
  return path.join("results", "sweeps", `${sweepId}.${extension}`);
}

function inferModelProvider(modelId: string): string {
  return modelId.split("/")[0] ?? "unknown";
}

function renderSweepMarkdownSummary(report: SweepReport): string {
  const filters = formatSelectionFilters(report.selection);
  const categoryAggregates = aggregateSweepEntries(report.entries, (entry) => entry.category);
  const trackAggregates = aggregateSweepEntries(report.entries, (entry) => entry.track);
  const taskSourceAggregates = ["public", "holdout"].map((taskSource) => ({
    key: taskSource,
    entries: report.entries.filter((entry) => entry.taskSource === taskSource),
  }));
  const failureHotspots = collectFailureHotspots(report.entries);

  const lines = [
    "# Benchmark Sweep Report",
    "",
    "## Metadata",
    `- Sweep ID: \`${report.sweepId}\``,
    `- Created: \`${report.createdAt}\``,
    `- Model: \`${report.modelId}\``,
    `- Provider: \`${report.modelProvider}\``,
    `- Mode: \`${report.mode}\``,
    `- Warm-cache: ${report.warmed ? "yes" : "no"}`,
    `- Strict capability: ${report.strictCapability ? "yes" : "no"}`,
    `- Runtime retry limit: ${report.runtimeRetryLimit}`,
    `- Max attempts: ${report.maxAttempts}`,
    report.selection.suiteId
      ? `- Suite: \`${report.selection.suiteId}\`${report.selection.suiteTitle ? ` (${report.selection.suiteTitle})` : ""}`
      : "- Suite: -",
    `- Filters: ${filters}`,
    "",
    "## Summary",
    `- Capability score: ${formatScore100(report.summary.averageScore)}/100`,
    `- Targets: ${report.summary.totalTargets}`,
    `- Total weight: ${formatWeight(report.summary.totalWeight)}`,
    `- Scored targets: ${report.summary.scoredTargets}`,
    `- Scored weight: ${formatWeight(report.summary.scoredWeight)}`,
    `- Runtime-excluded targets: ${report.summary.runtimeExcludedTargets}`,
    `- Runtime-excluded weight: ${formatWeight(report.summary.runtimeExcludedWeight)}`,
    `- Completed: ${report.summary.completedTargets}`,
    `- Failed: ${report.summary.failedTargets}`,
    `- Green: ${formatStageRatio(report.summary.greenTargets, report.summary.scoredTargets)}`,
    `- First-pass green: ${formatStageRatio(report.summary.firstPassGreenTargets, report.summary.scoredTargets)}`,
    `- Average attempts used: ${formatAttempts(report.summary.averageAttemptsUsed)}`,
    `- Average time-to-green: ${formatDurationMs(report.summary.averageTimeToGreenMs)}`,
    `- Public pairs: ${formatTaskSourceSummaryLine(report.summary.byTaskSource.public)}`,
    `- Holdout pairs: ${formatTaskSourceSummaryLine(report.summary.byTaskSource.holdout)}`,
    "",
    "## Pairs",
    formatMarkdownTable(
      [
        "Task",
        "Category",
        "Difficulty",
        "Weight",
        "Track",
        "Source",
        "Status",
        "Scoring",
        "Invokes",
        "Score/100",
        "Green",
        "Attempts",
        "TTG",
        "Build",
        "Public",
        "Hidden",
        "Adversarial",
        "Failure",
      ],
      report.entries.map((entry) => [
        entry.taskId,
        entry.category,
        entry.difficulty,
        formatWeight(entry.weight),
        entry.track,
        entry.taskSource,
        entry.status,
        formatScoringDisposition(entry),
        formatInvocationSummary(entry),
        formatScore100(entry.score),
        entry.reachedGreen ? "yes" : "no",
        `${entry.attemptCount}/${entry.maxAttempts}`,
        formatDurationMs(entry.timeToGreenMs),
        entry.buildSuccess ? "pass" : "fail",
        formatStageSummary(entry.buildSuccess, entry.tests.public.passed, entry.tests.public.total),
        formatStageSummary(entry.buildSuccess, entry.tests.hidden.passed, entry.tests.hidden.total),
        formatStageSummary(
          entry.buildSuccess,
          entry.tests.adversarial.passed,
          entry.tests.adversarial.total,
        ),
        entry.failureClasses.join(", ") || "none",
      ]),
    ),
    "",
    "## By Source",
    formatMarkdownTable(
      [
        "Group",
        "Pairs",
        "Scored",
        "Excluded",
        "Weight",
        "Green",
        "First Pass",
        "Avg Attempts",
        "Avg TTG",
        "Build",
        "Public",
        "Hidden",
        "Adversarial",
        "Avg/100",
      ],
      taskSourceAggregates.map(({ key, entries }) => {
        const summary = summarizeSweepEntries(entries);
        return [
          key,
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
          formatScore100(summary.averageScore),
        ];
      }),
    ),
    "",
    "## By Category",
    formatMarkdownTable(
      [
        "Group",
        "Pairs",
        "Scored",
        "Excluded",
        "Weight",
        "Green",
        "First Pass",
        "Avg Attempts",
        "Avg TTG",
        "Build",
        "Public",
        "Hidden",
        "Adversarial",
        "Avg/100",
      ],
      categoryAggregates.map(({ key, entries }) => {
        const summary = summarizeSweepEntries(entries);
        return [
          key,
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
          formatScore100(summary.averageScore),
        ];
      }),
    ),
    "",
    "## By Track",
    formatMarkdownTable(
      [
        "Group",
        "Pairs",
        "Scored",
        "Excluded",
        "Weight",
        "Green",
        "First Pass",
        "Avg Attempts",
        "Avg TTG",
        "Build",
        "Public",
        "Hidden",
        "Adversarial",
        "Avg/100",
      ],
      trackAggregates.map(({ key, entries }) => {
        const summary = summarizeSweepEntries(entries);
        return [
          key,
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
          formatScore100(summary.averageScore),
        ];
      }),
    ),
    "",
    "## Failure Hotspots",
    formatMarkdownTable(
      ["Class", "Count", "Pairs"],
      failureHotspots.length > 0
        ? failureHotspots.map((failure) => [
            failure.failureClass,
            String(failure.count),
            failure.pairs.join(", "),
          ])
        : [["none", "0", "-"]],
    ),
    "",
    "## Runtime Exclusions",
    formatMarkdownTable(
      ["Pair", "Reason"],
      collectRuntimeExclusions(report.entries).length > 0
        ? collectRuntimeExclusions(report.entries).map((entry) => [
            `${entry.taskId}/${entry.track}`,
            entry.errorStage ?? "runtime_failure",
          ])
        : [["none", "-"]],
    ),
    "",
  ];

  return lines.join("\n");
}

function formatSelectionFilters(selection: SweepSelection): string {
  const filters = [
    selection.track ? `track=\`${selection.track}\`` : undefined,
    selection.taskId ? `task=\`${selection.taskId}\`` : undefined,
    selection.difficulty ? `difficulty=\`${selection.difficulty}\`` : undefined,
  ].filter((value): value is string => value !== undefined);

  return filters.length > 0 ? filters.join(", ") : "-";
}

function formatMarkdownTable(headers: string[], rows: string[][]): string {
  const separator = headers.map(() => "---");
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownTableCell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function aggregateSweepEntries(
  entries: SweepEntry[],
  keyFn: (entry: SweepEntry) => string,
): Array<{ key: string; entries: SweepEntry[] }> {
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

function summarizeSweepEntries(entries: SweepEntry[]): {
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

function collectFailureHotspots(entries: SweepEntry[]): Array<{
  failureClass: string;
  count: number;
  pairs: string[];
}> {
  const failureMap = new Map<string, Set<string>>();
  for (const entry of entries.filter((candidate) => candidate.benchmarkEligible)) {
    for (const failureClass of entry.failureClasses) {
      const bucket = failureMap.get(failureClass) ?? new Set<string>();
      bucket.add(`${entry.taskId}/${entry.track}`);
      failureMap.set(failureClass, bucket);
    }
  }

  return [...failureMap.entries()]
    .map(([failureClass, pairs]) => ({
      failureClass,
      count: pairs.size,
      pairs: [...pairs].sort(),
    }))
    .sort((left, right) => right.count - left.count || left.failureClass.localeCompare(right.failureClass));
}

function collectRuntimeExclusions(entries: SweepEntry[]): SweepEntry[] {
  return entries
    .filter((entry) => !entry.benchmarkEligible)
    .sort((left, right) => {
      const taskCompare = left.taskId.localeCompare(right.taskId);
      if (taskCompare !== 0) {
        return taskCompare;
      }

      return left.track.localeCompare(right.track);
    });
}

function formatStageSummary(buildSuccess: boolean, passed: number, total: number): string {
  if (!buildSuccess && total === 0) {
    return "skipped";
  }

  return formatStageRatio(passed, total);
}

function formatStageRatio(passed: number, total: number): string {
  return `${passed}/${total}`;
}

function formatScore100(value: number): string {
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

function formatTaskSourceSummaryLine(summary: SweepTaskSourceSummary): string {
  return `${summary.totalTargets} total, ${summary.scoredTargets} scored, ${summary.runtimeExcludedTargets} excluded, weight ${formatWeight(summary.totalWeight)}`;
}

function formatScoringDisposition(entry: Pick<SweepEntry, "benchmarkEligible" | "errorStage">): string {
  if (entry.benchmarkEligible) {
    return "scored";
  }

  return `excluded:${entry.errorStage ?? "runtime"}`;
}

function formatInvocationSummary(entry: Pick<SweepEntry, "invocationAttempts" | "runtimeRetriesUsed">): string {
  if ((entry.runtimeRetriesUsed ?? 0) === 0) {
    return String(entry.invocationAttempts ?? 1);
  }

  return `${entry.invocationAttempts} (${entry.runtimeRetriesUsed} retry)`;
}

function classifyTaskSource(rootDir: string, taskRootDir: string | undefined): "public" | "holdout" {
  if (!taskRootDir) {
    return "public";
  }

  const relativePath = path.relative(rootDir, taskRootDir).split(path.sep).join("/");
  if (relativePath === "tasks-private" || relativePath.startsWith("tasks-private/")) {
    return "holdout";
  }

  return "public";
}
