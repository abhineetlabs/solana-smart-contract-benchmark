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
  runCommand,
  writeJsonFile,
  writeTextFile,
} from "../../shared/src/index.js";
import {
  getAdapterForModel,
  type BenchmarkReasoningEffort,
} from "../../model-adapters/src/index.js";
import { runBenchmark, type BenchmarkExecution, type AttemptResult } from "./run.js";
import { loadBenchmarkSuite, type BenchmarkSuite, type BenchmarkSuiteTarget } from "./suites.js";
import { warmTaskCache } from "./warm.js";

const SWEEP_REPORT_SCHEMA_VERSION = 3;

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
  taskVersion: string;
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
  scoreBreakdown: AttemptResult["score"]["breakdown"];
  buildSuccess: boolean;
  tests: AttemptResult["tests"];
  usage: AttemptResult["usage"];
  modelAdapter: string;
  finishReason?: string;
  reasoningEffort: BenchmarkReasoningEffort;
  providerReasoningEffort?: string;
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
  buildPassedTargets: number;
  greenTargets: number;
  firstPassGreenTargets: number;
  averageScore: number;
  averageAttemptsUsed: number;
  averageTimeToGreenMs?: number;
  publicPassed: number;
  publicTotal: number;
  hiddenPassed: number;
  hiddenTotal: number;
  adversarialPassed: number;
  adversarialTotal: number;
}

export interface SweepAggregateSummary {
  totalTargets: number;
  totalWeight: number;
  scoredTargets: number;
  scoredWeight: number;
  runtimeExcludedTargets: number;
  runtimeExcludedWeight: number;
  buildPassedTargets: number;
  greenTargets: number;
  firstPassGreenTargets: number;
  averageScore: number;
  averageAttemptsUsed: number;
  averageTimeToGreenMs?: number;
  publicPassed: number;
  publicTotal: number;
  hiddenPassed: number;
  hiddenTotal: number;
  adversarialPassed: number;
  adversarialTotal: number;
}

export interface SweepUsageSummary {
  entriesWithUsage: number;
  entriesWithTokenUsage: number;
  entriesWithCost: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  latencyMs: number;
  averageLatencyMs: number;
  averageTotalTokensPerEntry?: number;
  averageTotalTokensPerScoredTarget?: number;
}

export interface SweepReliabilitySummary {
  fullSweepCompleted: boolean;
  totalInvocations: number;
  runtimeRetriesUsed: number;
  averageInvocationAttempts: number;
  retryFreeTargets: number;
  retryFreeTargetRate: number;
  scoredTargetRate: number;
  runtimeExclusionRate: number;
  greenTargetRate: number;
  firstPassGreenTargetRate: number;
  buildPassTargetRate: number;
}

export interface SweepSummaryBreakdowns {
  byTaskSource: Record<string, SweepAggregateSummary>;
  byTrack: Record<string, SweepAggregateSummary>;
  byDifficulty: Record<string, SweepAggregateSummary>;
  byInteractionMode: Record<string, SweepAggregateSummary>;
  byCategory: Record<string, SweepAggregateSummary>;
}

export interface SweepEnvironment {
  benchmarkCommit?: string;
  benchmarkDirty?: boolean;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  toolchain?: Record<string, string | null>;
}

export interface SweepSuiteMetadata {
  id: string;
  title: string;
  description: string;
  tags: string[];
  sourcePath?: string;
  relativeId?: string;
  fingerprint?: string;
  targetCount: number;
  selectedTargetCount: number;
  configuredTotalWeight: number;
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
  usage: SweepUsageSummary;
  reliability: SweepReliabilitySummary;
  breakdowns: SweepSummaryBreakdowns;
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

export interface SweepResumeMetadata {
  sourceSweepId: string;
  sourceCreatedAt: string;
  sourceBenchmarkCommit?: string;
  sourceBenchmarkDirty?: boolean;
  rerunTargetCount: number;
  carriedForwardTargetCount: number;
  retriedRuntimeExcluded: boolean;
  retryStages: string[];
  retryTargetKeys: string[];
}

export interface SweepReport {
  schemaVersion: number;
  sweepId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  createdAt: string;
  modelId: string;
  modelProvider: string;
  modelAdapter: string;
  reasoningEffort: BenchmarkReasoningEffort;
  providerReasoningEffort?: string;
  mode: InvocationMode;
  warmed: boolean;
  strictCapability: boolean;
  runtimeRetryLimit: number;
  suiteId?: string;
  suite?: SweepSuiteMetadata;
  environment?: SweepEnvironment;
  selection: SweepSelection;
  maxAttempts: number;
  artifacts: SweepArtifacts;
  resume?: SweepResumeMetadata;
  summary: SweepSummary;
  entries: SweepEntry[];
}

interface RunBenchmarkSweepArgs {
  rootDir: string;
  modelId: string;
  mode?: InvocationMode;
  reasoningEffort?: BenchmarkReasoningEffort;
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

interface ResumeBenchmarkSweepArgs {
  rootDir: string;
  sourceSweepId: string;
  retryRuntimeExcluded?: boolean;
  retryStages?: string[];
  retryTargetKeys?: string[];
  warmCache?: boolean;
  onProgress?: (message: string) => void;
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
  const startedAtDate = new Date();
  const startedAtMs = startedAtDate.getTime();
  const mode = args.mode ?? "offline";
  const reasoningEffort = args.reasoningEffort ?? "default";
  const maxAttempts = args.maxAttempts ?? 1;
  const strictCapability = args.strictCapability ?? false;
  const runtimeRetryLimit = strictCapability ? Math.max(args.runtimeRetryLimit ?? 2, 0) : 0;
  const suite = args.suiteId ? await loadBenchmarkSuite(args.rootDir, args.suiteId) : undefined;
  const modelAdapter = getAdapterForModel(args.modelId).id;
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
  const entries = await executeSweepTargets({
    rootDir: args.rootDir,
    targets,
    modelId: args.modelId,
    mode,
    reasoningEffort,
    maxAttempts,
    strictCapability,
    runtimeRetryLimit,
    warmCache: args.warmCache ?? false,
    onProgress: args.onProgress,
  });

  const endedAtDate = new Date();
  const report: SweepReport = {
    schemaVersion: SWEEP_REPORT_SCHEMA_VERSION,
    sweepId,
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: endedAtDate.getTime() - startedAtMs,
    createdAt: endedAtDate.toISOString(),
    modelId: args.modelId,
    modelProvider: inferModelProvider(args.modelId),
    modelAdapter,
    reasoningEffort,
    providerReasoningEffort: inferSweepProviderReasoningEffort(entries, reasoningEffort),
    mode,
    warmed: args.warmCache ?? false,
    strictCapability,
    runtimeRetryLimit,
    suiteId: args.suiteId,
    suite: suite
      ? buildSweepSuiteMetadata(suite, targets)
      : undefined,
    environment: await collectSweepEnvironment(args.rootDir),
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

export async function resumeBenchmarkSweep(args: ResumeBenchmarkSweepArgs): Promise<SweepReport> {
  const [sourceReport] = await loadSweepReports({
    rootDir: args.rootDir,
    sweepIds: [args.sourceSweepId],
  });

  if (!sourceReport) {
    throw new Error(`No sweep report found for ${args.sourceSweepId}.`);
  }

  const retryRuntimeExcluded = args.retryRuntimeExcluded ?? true;
  const retryStages = normalizeRetryStages(args.retryStages);
  const retryTargetKeys = normalizeRetryTargetKeys(args.retryTargetKeys);
  const sourceTargetKeys = new Set(sourceReport.entries.map((entry) => toTargetKey(entry.taskId, entry.track)));
  const unknownRetryTargetKeys = retryTargetKeys.filter((targetKey) => !sourceTargetKeys.has(targetKey));
  if (unknownRetryTargetKeys.length > 0) {
    throw new Error(
      `The following retry targets are not present in sweep ${args.sourceSweepId}: ${unknownRetryTargetKeys.join(", ")}.`,
    );
  }
  const selectedEntries = sourceReport.entries.filter((entry) =>
    shouldRerunEntry(entry, { retryRuntimeExcluded, retryStages, retryTargetKeys }),
  );

  if (selectedEntries.length === 0) {
    throw new Error(
      describeEmptyResumeSelection(args.sourceSweepId, {
        retryRuntimeExcluded,
        retryStages,
        retryTargetKeys,
      }),
    );
  }

  const startedAtDate = new Date();
  const startedAtMs = startedAtDate.getTime();
  const sweepId = createSweepId();
  const targets = selectedEntries.map(toBenchmarkTargetFromEntry);
  const rerunEntries = await executeSweepTargets({
    rootDir: args.rootDir,
    targets,
    modelId: sourceReport.modelId,
    mode: sourceReport.mode,
    maxAttempts: sourceReport.maxAttempts,
    strictCapability: sourceReport.strictCapability,
    runtimeRetryLimit: sourceReport.runtimeRetryLimit,
    reasoningEffort: sourceReport.reasoningEffort,
    warmCache: args.warmCache ?? false,
    onProgress: args.onProgress,
  });
  const rerunEntryMap = new Map(
    rerunEntries.map((entry) => [toTargetKey(entry.taskId, entry.track), entry]),
  );
  const mergedEntries = sourceReport.entries.map(
    (entry) => rerunEntryMap.get(toTargetKey(entry.taskId, entry.track)) ?? entry,
  );
  const endedAtDate = new Date();

  const report: SweepReport = {
    schemaVersion: SWEEP_REPORT_SCHEMA_VERSION,
    sweepId,
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: endedAtDate.getTime() - startedAtMs,
    createdAt: endedAtDate.toISOString(),
    modelId: sourceReport.modelId,
    modelProvider: inferModelProvider(sourceReport.modelId),
    modelAdapter: getAdapterForModel(sourceReport.modelId).id,
    reasoningEffort: sourceReport.reasoningEffort,
    providerReasoningEffort: inferSweepProviderReasoningEffort(
      mergedEntries,
      sourceReport.reasoningEffort,
      sourceReport.providerReasoningEffort,
    ),
    mode: sourceReport.mode,
    warmed: args.warmCache ?? false,
    strictCapability: sourceReport.strictCapability,
    runtimeRetryLimit: sourceReport.runtimeRetryLimit,
    suiteId: sourceReport.suiteId,
    suite: sourceReport.suite,
    environment: await collectSweepEnvironment(args.rootDir),
    selection: sourceReport.selection,
    maxAttempts: sourceReport.maxAttempts,
    artifacts: buildSweepArtifacts(sweepId),
    resume: {
      sourceSweepId: sourceReport.sweepId,
      sourceCreatedAt: sourceReport.createdAt,
      sourceBenchmarkCommit: sourceReport.environment?.benchmarkCommit,
      sourceBenchmarkDirty: sourceReport.environment?.benchmarkDirty,
      rerunTargetCount: rerunEntries.length,
      carriedForwardTargetCount: mergedEntries.length - rerunEntries.length,
      retriedRuntimeExcluded: retryRuntimeExcluded,
      retryStages,
      retryTargetKeys,
    },
    summary: computeSweepSummary(mergedEntries),
    entries: mergedEntries,
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
    taskVersion: execution.result.taskVersion,
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
    scoreBreakdown: execution.result.score.breakdown,
    buildSuccess: execution.result.build.success,
    tests: execution.result.tests,
    usage: execution.result.usage,
    modelAdapter: execution.result.model.adapterId,
    finishReason: execution.result.model.finishReason,
    reasoningEffort: execution.result.model.reasoningEffort,
    providerReasoningEffort: execution.result.model.providerReasoningEffort,
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

async function executeSweepTargets(args: {
  rootDir: string;
  targets: BenchmarkTarget[];
  modelId: string;
  mode: InvocationMode;
  reasoningEffort: BenchmarkReasoningEffort;
  maxAttempts: number;
  strictCapability: boolean;
  runtimeRetryLimit: number;
  warmCache: boolean;
  onProgress?: (message: string) => void;
}): Promise<SweepEntry[]> {
  const entries: SweepEntry[] = [];

  for (const [targetIndex, target] of args.targets.entries()) {
    const progressPrefix = `[${targetIndex + 1}/${args.targets.length}] ${target.taskId}/${target.track}`;
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
      mode: args.mode,
      reasoningEffort: args.reasoningEffort,
      interactionMode: target.interactionMode,
      maxAttempts: args.maxAttempts,
      strictCapability: args.strictCapability,
      runtimeRetryLimit: args.runtimeRetryLimit,
      onProgress: args.onProgress,
      progressPrefix,
    });

    const entry = toSweepEntry(target, args.rootDir, execution);
    entries.push(entry);
    args.onProgress?.(
      `${progressPrefix}: target finished (${entry.scoringDisposition === "scored" ? `${formatScore100(entry.score)}/100` : `excluded:${entry.errorStage ?? "runtime"}`})`,
    );
  }

  return entries;
}

function computeSweepSummary(entries: SweepEntry[]): SweepSummary {
  const overall = computeAggregateSummary(entries);
  const scoredEntries = entries.filter((entry) => entry.benchmarkEligible);
  const completedTargets = scoredEntries.filter((entry) => entry.status === "completed").length;
  const byTaskSource = {
    public: computeTaskSourceSummary(entries, "public"),
    holdout: computeTaskSourceSummary(entries, "holdout"),
  };

  return {
    totalTargets: overall.totalTargets,
    totalWeight: overall.totalWeight,
    scoredTargets: overall.scoredTargets,
    scoredWeight: overall.scoredWeight,
    runtimeExcludedTargets: overall.runtimeExcludedTargets,
    runtimeExcludedWeight: overall.runtimeExcludedWeight,
    completedTargets,
    failedTargets: scoredEntries.length - completedTargets,
    buildPassedTargets: overall.buildPassedTargets,
    greenTargets: overall.greenTargets,
    firstPassGreenTargets: overall.firstPassGreenTargets,
    averageScore: overall.averageScore,
    averageAttemptsUsed: overall.averageAttemptsUsed,
    averageTimeToGreenMs: overall.averageTimeToGreenMs,
    byTaskSource,
    usage: computeUsageSummary(entries),
    reliability: computeReliabilitySummary(entries),
    breakdowns: {
      byTaskSource,
      byTrack: computeAggregateBreakdown(entries, (entry) => entry.track),
      byDifficulty: computeAggregateBreakdown(entries, (entry) => entry.difficulty),
      byInteractionMode: computeAggregateBreakdown(entries, (entry) => entry.interactionMode),
      byCategory: computeAggregateBreakdown(entries, (entry) => entry.category),
    },
  };
}

async function persistSweepReport(rootDir: string, report: SweepReport): Promise<void> {
  const normalizedReport: SweepReport = {
    ...report,
    schemaVersion: report.schemaVersion ?? SWEEP_REPORT_SCHEMA_VERSION,
    startedAt: report.startedAt ?? report.createdAt,
    endedAt: report.endedAt ?? report.createdAt,
    durationMs: report.durationMs ?? 0,
    modelProvider: report.modelProvider ?? inferModelProvider(report.modelId),
    modelAdapter: report.modelAdapter ?? getAdapterForModel(report.modelId).id,
    reasoningEffort: report.reasoningEffort ?? inferSweepReasoningEffort(report.entries),
    providerReasoningEffort:
      report.providerReasoningEffort
      ?? inferSweepProviderReasoningEffort(report.entries, report.reasoningEffort),
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

function normalizeRetryStages(stages: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (stages ?? [])
        .map((stage) => stage.trim())
        .filter((stage) => stage.length > 0),
    ),
  );
}

function normalizeRetryTargetKeys(targetKeys: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (targetKeys ?? [])
        .map((targetKey) => targetKey.trim())
        .filter((targetKey) => targetKey.length > 0),
    ),
  );
}

function shouldRerunEntry(
  entry: SweepEntry,
  args: {
    retryRuntimeExcluded: boolean;
    retryStages: string[];
    retryTargetKeys: string[];
  },
): boolean {
  if (args.retryTargetKeys.includes(toTargetKey(entry.taskId, entry.track))) {
    return true;
  }

  if (args.retryRuntimeExcluded && !entry.benchmarkEligible) {
    return true;
  }

  return entry.errorStage !== undefined && args.retryStages.includes(entry.errorStage);
}

function describeEmptyResumeSelection(
  sourceSweepId: string,
  args: {
    retryRuntimeExcluded: boolean;
    retryStages: string[];
    retryTargetKeys: string[];
  },
): string {
  const selectors: string[] = [];
  if (args.retryRuntimeExcluded) {
    selectors.push("runtime exclusions");
  }
  if (args.retryStages.length > 0) {
    selectors.push(`stages: ${args.retryStages.join(", ")}`);
  }
  if (args.retryTargetKeys.length > 0) {
    selectors.push(`targets: ${args.retryTargetKeys.join(", ")}`);
  }

  if (selectors.length === 0) {
    return `No resume selectors were provided for sweep ${sourceSweepId}.`;
  }

  return `No matching entries found in sweep ${sourceSweepId} for ${selectors.join(" | ")}.`;
}

function toBenchmarkTargetFromEntry(entry: SweepEntry): BenchmarkTarget {
  return {
    taskId: entry.taskId,
    track: entry.track,
    category: entry.category,
    difficulty: entry.difficulty,
    interactionMode: entry.interactionMode,
    title: entry.title,
    weight: entry.weight,
    taskSource: entry.taskSource,
  };
}

function toTargetKey(taskId: string, track: TrackId): string {
  return `${taskId}/${track}`;
}

async function normalizeSweepReport(rootDir: string, report: SweepReport): Promise<SweepReport> {
  const tasks = await discoverTasks(rootDir);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const suiteId = report.selection?.suiteId ?? report.suiteId;
  const suite = suiteId ? await loadBenchmarkSuite(rootDir, suiteId).catch(() => undefined) : undefined;
  const modelAdapter = report.modelAdapter ?? getAdapterForModel(report.modelId).id;
  const reasoningEffort = report.reasoningEffort ?? inferSweepReasoningEffort(report.entries);
  const providerReasoningEffort =
    report.providerReasoningEffort
    ?? inferSweepProviderReasoningEffort(report.entries, reasoningEffort);

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
    const usage = entry.usage ?? storedAttempt?.usage ?? { latencyMs: 0 };
    const scoreBreakdown = entry.scoreBreakdown ?? storedAttempt?.score.breakdown ?? emptyScoreBreakdown();

    return {
      ...entry,
      taskVersion: entry.taskVersion ?? storedAttempt?.taskVersion ?? task?.spec.version ?? "unknown",
      interactionMode,
      weight: normalizeTargetWeight(weight),
      taskSource,
      errorStage,
      scoreBreakdown,
      usage,
      modelAdapter: entry.modelAdapter ?? storedAttempt?.model.adapterId ?? modelAdapter,
      finishReason: entry.finishReason ?? storedAttempt?.model.finishReason,
      reasoningEffort: entry.reasoningEffort ?? storedAttempt?.model.reasoningEffort ?? reasoningEffort,
      providerReasoningEffort:
        entry.providerReasoningEffort
        ?? storedAttempt?.model.providerReasoningEffort
        ?? providerReasoningEffort,
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
    schemaVersion: report.schemaVersion ?? 1,
    startedAt: report.startedAt ?? report.createdAt,
    endedAt: report.endedAt ?? report.createdAt,
    durationMs: report.durationMs ?? entries.reduce((sum, entry) => sum + entry.totalDurationMs, 0),
    modelProvider: report.modelProvider ?? inferModelProvider(report.modelId),
    modelAdapter,
    reasoningEffort,
    providerReasoningEffort,
    strictCapability: report.strictCapability ?? false,
    runtimeRetryLimit: report.runtimeRetryLimit ?? 0,
    suiteId,
    suite:
      report.suite ??
      (suite ? buildSweepSuiteMetadata(suite, entries.map((entry) => ({
        taskId: entry.taskId,
        track: entry.track,
        category: entry.category,
        difficulty: entry.difficulty,
        interactionMode: entry.interactionMode,
        title: entry.title,
        weight: entry.weight,
        taskSource: entry.taskSource,
      }))) : undefined),
    environment: report.environment,
    selection: {
      suiteId,
      suiteTitle: report.selection?.suiteTitle ?? suite?.title,
      track: report.selection?.track,
      taskId: report.selection?.taskId,
      difficulty: report.selection?.difficulty,
    },
    artifacts: report.artifacts ?? buildSweepArtifacts(report.sweepId),
    resume: report.resume
      ? {
          ...report.resume,
          retryStages: normalizeRetryStages(report.resume.retryStages),
          retryTargetKeys: normalizeRetryTargetKeys(report.resume.retryTargetKeys),
        }
      : undefined,
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
  return computeAggregateSummary(entries.filter((entry) => entry.taskSource === taskSource));
}

function computeAggregateSummary(entries: SweepEntry[]): SweepAggregateSummary {
  const scoredEntries = entries.filter((entry) => entry.benchmarkEligible);
  const runtimeExcludedEntries = entries.filter((entry) => !entry.benchmarkEligible);
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
    buildPassedTargets: scoredEntries.filter((entry) => entry.buildSuccess).length,
    greenTargets: scoredEntries.filter((entry) => entry.reachedGreen).length,
    firstPassGreenTargets: scoredEntries.filter((entry) => entry.firstPassGreen).length,
    averageScore: scoredWeight === 0 ? 0 : roundScore(totalScore / scoredWeight),
    averageAttemptsUsed: roundAttempts(weightedAverage(scoredEntries, (entry) => entry.attemptCount)),
    averageTimeToGreenMs: weightedAverage(
      scoredEntries,
      (entry) => entry.timeToGreenMs,
      (entry) => entry.reachedGreen,
    ),
    publicPassed: scoredEntries.reduce((sum, entry) => sum + entry.tests.public.passed, 0),
    publicTotal: scoredEntries.reduce((sum, entry) => sum + entry.tests.public.total, 0),
    hiddenPassed: scoredEntries.reduce((sum, entry) => sum + entry.tests.hidden.passed, 0),
    hiddenTotal: scoredEntries.reduce((sum, entry) => sum + entry.tests.hidden.total, 0),
    adversarialPassed: scoredEntries.reduce((sum, entry) => sum + entry.tests.adversarial.passed, 0),
    adversarialTotal: scoredEntries.reduce((sum, entry) => sum + entry.tests.adversarial.total, 0),
  };
}

function computeAggregateBreakdown(
  entries: SweepEntry[],
  keyFn: (entry: SweepEntry) => string,
): Record<string, SweepAggregateSummary> {
  return Object.fromEntries(
    aggregateSweepEntries(entries, keyFn).map(({ key, entries: bucketEntries }) => [
      key,
      computeAggregateSummary(bucketEntries),
    ]),
  );
}

function computeUsageSummary(entries: SweepEntry[]): SweepUsageSummary {
  const entriesWithUsage = entries.filter(hasMeasuredUsage);
  const entriesWithTokenUsage = entries.filter((entry) => entry.usage.totalTokens !== undefined);
  const scoredEntriesWithTokenUsage = entries.filter(
    (entry) => entry.benchmarkEligible && entry.usage.totalTokens !== undefined,
  );
  const entriesWithCost = entries.filter((entry) => entry.usage.estimatedCostUsd !== undefined);

  return {
    entriesWithUsage: entriesWithUsage.length,
    entriesWithTokenUsage: entriesWithTokenUsage.length,
    entriesWithCost: entriesWithCost.length,
    promptTokens: sumOptionalMetric(entries, (entry) => entry.usage.promptTokens),
    completionTokens: sumOptionalMetric(entries, (entry) => entry.usage.completionTokens),
    totalTokens: sumOptionalMetric(entries, (entry) => entry.usage.totalTokens),
    estimatedCostUsd: sumOptionalMetric(entries, (entry) => entry.usage.estimatedCostUsd),
    latencyMs: roundMetric(entries.reduce((sum, entry) => sum + (entry.usage.latencyMs ?? 0), 0)),
    averageLatencyMs:
      entries.length === 0
        ? 0
        : roundMetric(
            entries.reduce((sum, entry) => sum + (entry.usage.latencyMs ?? 0), 0) / entries.length,
          ),
    averageTotalTokensPerEntry:
      entriesWithTokenUsage.length === 0
        ? undefined
        : roundMetric(
            entriesWithTokenUsage.reduce((sum, entry) => sum + (entry.usage.totalTokens ?? 0), 0)
              / entriesWithTokenUsage.length,
          ),
    averageTotalTokensPerScoredTarget:
      scoredEntriesWithTokenUsage.length === 0
        ? undefined
        : roundMetric(
            scoredEntriesWithTokenUsage.reduce((sum, entry) => sum + (entry.usage.totalTokens ?? 0), 0)
              / scoredEntriesWithTokenUsage.length,
          ),
  };
}

function computeReliabilitySummary(entries: SweepEntry[]): SweepReliabilitySummary {
  const scoredEntries = entries.filter((entry) => entry.benchmarkEligible);
  const retryFreeTargets = entries.filter((entry) => entry.invocationAttempts <= 1).length;
  const totalInvocations = entries.reduce((sum, entry) => sum + entry.invocationAttempts, 0);
  const runtimeRetriesUsed = entries.reduce((sum, entry) => sum + entry.runtimeRetriesUsed, 0);

  return {
    fullSweepCompleted: entries.every((entry) => entry.benchmarkEligible),
    totalInvocations,
    runtimeRetriesUsed,
    averageInvocationAttempts:
      entries.length === 0 ? 0 : roundAttempts(totalInvocations / entries.length),
    retryFreeTargets,
    retryFreeTargetRate: roundRate(retryFreeTargets, entries.length),
    scoredTargetRate: roundRate(scoredEntries.length, entries.length),
    runtimeExclusionRate: roundRate(entries.length - scoredEntries.length, entries.length),
    greenTargetRate: roundRate(
      scoredEntries.filter((entry) => entry.reachedGreen).length,
      scoredEntries.length,
    ),
    firstPassGreenTargetRate: roundRate(
      scoredEntries.filter((entry) => entry.firstPassGreen).length,
      scoredEntries.length,
    ),
    buildPassTargetRate: roundRate(
      scoredEntries.filter((entry) => entry.buildSuccess).length,
      scoredEntries.length,
    ),
  };
}

function sumOptionalMetric(
  entries: SweepEntry[],
  pick: (entry: SweepEntry) => number | undefined,
): number | undefined {
  let found = false;
  let total = 0;

  for (const entry of entries) {
    const value = pick(entry);
    if (value === undefined) {
      continue;
    }

    found = true;
    total += value;
  }

  return found ? roundMetric(total) : undefined;
}

function hasMeasuredUsage(entry: SweepEntry): boolean {
  return (
    entry.usage.latencyMs > 0
    || entry.usage.promptTokens !== undefined
    || entry.usage.completionTokens !== undefined
    || entry.usage.totalTokens !== undefined
    || entry.usage.estimatedCostUsd !== undefined
  );
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

function roundMetric(value: number): number {
  return Number(value.toFixed(2));
}

function roundRate(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }

  return roundScore(numerator / denominator);
}

function emptyScoreBreakdown(): AttemptResult["score"]["breakdown"] {
  return {
    build: 0,
    public: 0,
    hidden: 0,
    adversarial: 0,
    efficiency: 0,
  };
}

function buildSweepSuiteMetadata(
  suite: BenchmarkSuite,
  targets: BenchmarkTarget[],
): SweepSuiteMetadata {
  return {
    id: suite.id,
    title: suite.title,
    description: suite.description,
    tags: [...(suite.tags ?? [])],
    sourcePath: suite.sourcePath,
    relativeId: suite.relativeId,
    fingerprint: suite.fingerprint,
    targetCount: suite.targets.length,
    selectedTargetCount: targets.length,
    configuredTotalWeight: roundWeight(
      targets.reduce((sum, target) => sum + normalizeTargetWeight(target.weight), 0),
    ),
  };
}

async function collectSweepEnvironment(rootDir: string): Promise<SweepEnvironment> {
  const [toolchain, gitCommitResult, gitStatusResult] = await Promise.all([
    readJsonFile<Record<string, string | null>>(path.join(rootDir, "configs", "toolchains.json"))
      .catch(() => undefined),
    runCommand("git rev-parse HEAD", rootDir),
    runCommand("git status --porcelain", rootDir),
  ]);

  return {
    benchmarkCommit: gitCommitResult.success ? gitCommitResult.stdout.trim() || undefined : undefined,
    benchmarkDirty: gitStatusResult.success
      ? gitStatusResult.stdout.trim().length > 0
      : undefined,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    toolchain,
  };
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

function inferSweepReasoningEffort(
  entries: Array<Pick<SweepEntry, "reasoningEffort">>,
): BenchmarkReasoningEffort {
  return entries[0]?.reasoningEffort ?? "default";
}

function inferSweepProviderReasoningEffort(
  entries: Array<Pick<SweepEntry, "providerReasoningEffort">>,
  reasoningEffort: BenchmarkReasoningEffort,
  fallback?: string,
): string {
  return entries[0]?.providerReasoningEffort ?? fallback ?? reasoningEffort;
}

function renderSweepMarkdownSummary(report: SweepReport): string {
  const filters = formatSelectionFilters(report.selection);
  const categoryAggregates = aggregateSweepEntries(report.entries, (entry) => entry.category);
  const trackAggregates = aggregateSweepEntries(report.entries, (entry) => entry.track);
  const difficultyAggregates = aggregateSweepEntries(report.entries, (entry) => entry.difficulty);
  const interactionModeAggregates = aggregateSweepEntries(report.entries, (entry) => entry.interactionMode);
  const taskSourceAggregates = ["public", "holdout"].map((taskSource) => ({
    key: taskSource,
    entries: report.entries.filter((entry) => entry.taskSource === taskSource),
  }));
  const failureHotspots = collectFailureHotspots(report.entries);

  const lines = [
    "# Benchmark Sweep Report",
    "",
    "## Metadata",
    `- Schema version: \`${report.schemaVersion}\``,
    `- Sweep ID: \`${report.sweepId}\``,
    `- Started: \`${report.startedAt}\``,
    `- Ended: \`${report.endedAt}\``,
    `- Duration: ${formatDurationMs(report.durationMs)}`,
    `- Created: \`${report.createdAt}\``,
    `- Model: \`${report.modelId}\``,
    `- Provider: \`${report.modelProvider}\``,
    `- Adapter: \`${report.modelAdapter}\``,
    `- Reasoning effort: \`${report.reasoningEffort}\`${report.providerReasoningEffort && report.providerReasoningEffort !== report.reasoningEffort ? ` (provider \`${report.providerReasoningEffort}\`)` : ""}`,
    `- Mode: \`${report.mode}\``,
    `- Warm-cache: ${report.warmed ? "yes" : "no"}`,
    `- Strict capability: ${report.strictCapability ? "yes" : "no"}`,
    `- Runtime retry limit: ${report.runtimeRetryLimit}`,
    `- Max attempts: ${report.maxAttempts}`,
    report.environment?.benchmarkCommit
      ? `- Benchmark commit: \`${report.environment.benchmarkCommit}\`${report.environment.benchmarkDirty !== undefined ? ` (${report.environment.benchmarkDirty ? "dirty" : "clean"})` : ""}`
      : "- Benchmark commit: -",
    report.environment?.platform || report.environment?.arch || report.environment?.nodeVersion
      ? `- Runtime env: \`${report.environment?.platform ?? "unknown"}\` / \`${report.environment?.arch ?? "unknown"}\` / Node \`${report.environment?.nodeVersion ?? "unknown"}\``
      : "- Runtime env: -",
    report.environment?.toolchain
      ? `- Toolchain: ${formatToolchainSummary(report.environment.toolchain)}`
      : "- Toolchain: -",
    report.selection.suiteId
      ? `- Suite: \`${report.selection.suiteId}\`${report.selection.suiteTitle ? ` (${report.selection.suiteTitle})` : ""}`
      : "- Suite: -",
    report.suite?.fingerprint
      ? `- Suite fingerprint: \`${report.suite.fingerprint}\``
      : "- Suite fingerprint: -",
    report.resume
      ? `- Resumed from: \`${report.resume.sourceSweepId}\` (reran ${report.resume.rerunTargetCount}, carried ${report.resume.carriedForwardTargetCount})`
      : "- Resumed from: -",
    report.resume?.sourceBenchmarkCommit
      ? `- Resume source benchmark: \`${report.resume.sourceBenchmarkCommit}\`${report.resume.sourceBenchmarkDirty !== undefined ? ` (${report.resume.sourceBenchmarkDirty ? "dirty" : "clean"})` : ""}`
      : "- Resume source benchmark: -",
    report.resume
      ? `- Resume selection: runtime-excluded ${report.resume.retriedRuntimeExcluded ? "yes" : "no"}${report.resume.retryStages.length > 0 ? `, stages ${report.resume.retryStages.join(", ")}` : ""}${report.resume.retryTargetKeys.length > 0 ? `, targets ${report.resume.retryTargetKeys.join(", ")}` : ""}`
      : "- Resume selection: -",
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
    `- Usage: ${formatUsageSummaryLine(report.summary.usage)}`,
    `- Reliability: ${formatReliabilitySummaryLine(report.summary.reliability)}`,
    `- Track slices: ${formatBreakdownScoreLine(report.summary.breakdowns.byTrack, ["anchor", "native", "pinocchio"])}`,
    `- Mode slices: ${formatBreakdownScoreLine(report.summary.breakdowns.byInteractionMode, ["generate", "repair", "migrate"])}`,
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
    "## By Difficulty",
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
      difficultyAggregates.map(({ key, entries }) => {
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
    "## By Interaction Mode",
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
      interactionModeAggregates.map(({ key, entries }) => {
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
  return `${summary.totalTargets} total, ${summary.scoredTargets} scored, ${summary.runtimeExcludedTargets} excluded, weight ${formatWeight(summary.totalWeight)}, avg ${formatScore100(summary.averageScore)}/100`;
}

function formatToolchainSummary(toolchain: Record<string, string | null>): string {
  const entries = Object.entries(toolchain)
    .map(([key, value]) => `${key}=\`${value ?? "unknown"}\``)
    .sort();

  return entries.length > 0 ? entries.join(", ") : "-";
}

function formatUsageSummaryLine(summary: SweepUsageSummary): string {
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

function formatReliabilitySummaryLine(summary: SweepReliabilitySummary): string {
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

function formatBreakdownScoreLine(
  breakdown: Record<string, SweepAggregateSummary>,
  orderedKeys: string[],
): string {
  const seen = new Set<string>();
  const segments: string[] = [];

  for (const key of orderedKeys) {
    const summary = breakdown[key];
    if (!summary) {
      continue;
    }

    segments.push(`${key} ${formatScore100(summary.averageScore)}/100`);
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

    segments.push(`${key} ${formatScore100(summary.averageScore)}/100`);
  }

  return segments.length > 0 ? segments.join(", ") : "-";
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
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
