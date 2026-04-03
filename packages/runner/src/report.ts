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
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from "../../shared/src/index.js";
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
}

export interface SweepEntry {
  taskId: string;
  track: TrackId;
  category: string;
  difficulty: Difficulty;
  interactionMode: InteractionMode;
  title: string;
  weight: number;
  runId: string;
  attemptId: string;
  status: AttemptResult["status"];
  score: number;
  buildSuccess: boolean;
  tests: AttemptResult["tests"];
  failureClasses: string[];
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

export interface SweepSummary {
  totalTargets: number;
  totalWeight: number;
  completedTargets: number;
  failedTargets: number;
  buildPassedTargets: number;
  greenTargets: number;
  firstPassGreenTargets: number;
  averageScore: number;
  averageAttemptsUsed: number;
  averageTimeToGreenMs?: number;
}

export interface SweepReport {
  sweepId: string;
  createdAt: string;
  modelId: string;
  mode: InvocationMode;
  warmed: boolean;
  suiteId?: string;
  maxAttempts: number;
  summary: SweepSummary;
  entries: SweepEntry[];
}

interface RunBenchmarkSweepArgs {
  rootDir: string;
  modelId: string;
  mode?: InvocationMode;
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

  for (const target of targets) {
    if (args.warmCache) {
      await warmTaskCache({
        rootDir: args.rootDir,
        taskId: target.taskId,
        track: target.track,
      });
    }

    const execution = await runBenchmark({
      rootDir: args.rootDir,
      taskId: target.taskId,
      track: target.track,
      modelId: args.modelId,
      mode,
      maxAttempts,
    });

    entries.push(toSweepEntry(target, args.rootDir, execution));
  }

  const report: SweepReport = {
    sweepId,
    createdAt: new Date().toISOString(),
    modelId: args.modelId,
    mode,
    warmed: args.warmCache ?? false,
    suiteId: args.suiteId,
    maxAttempts,
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
    runId: execution.result.runId,
    attemptId: execution.result.attemptId,
    status: execution.result.status,
    score: execution.result.score.total,
    buildSuccess: execution.result.build.success,
    tests: execution.result.tests,
    failureClasses: execution.result.failureClasses,
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
  const completedTargets = entries.filter((entry) => entry.status === "completed").length;
  const buildPassedTargets = entries.filter((entry) => entry.buildSuccess).length;
  const totalWeight = entries.reduce((sum, entry) => sum + normalizeTargetWeight(entry.weight), 0);
  const totalScore = entries.reduce(
    (sum, entry) => sum + entry.score * normalizeTargetWeight(entry.weight),
    0,
  );

  return {
    totalTargets: entries.length,
    totalWeight: roundWeight(totalWeight),
    completedTargets,
    failedTargets: entries.length - completedTargets,
    buildPassedTargets,
    greenTargets: entries.filter((entry) => entry.reachedGreen).length,
    firstPassGreenTargets: entries.filter((entry) => entry.firstPassGreen).length,
    averageScore: totalWeight === 0 ? 0 : roundScore(totalScore / totalWeight),
    averageAttemptsUsed: roundAttempts(weightedAverage(entries, (entry) => entry.attemptCount)),
    averageTimeToGreenMs: weightedAverage(entries, (entry) => entry.timeToGreenMs, (entry) => entry.reachedGreen),
  };
}

async function persistSweepReport(rootDir: string, report: SweepReport): Promise<void> {
  const sweepsDir = path.join(rootDir, "results", "sweeps");
  await ensureDir(sweepsDir);
  await writeJsonFile(path.join(sweepsDir, `${report.sweepId}.json`), report);
}

function createSweepId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
}

async function normalizeSweepReport(rootDir: string, report: SweepReport): Promise<SweepReport> {
  const tasks = await discoverTasks(rootDir);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const suite = report.suiteId ? await loadBenchmarkSuite(rootDir, report.suiteId).catch(() => undefined) : undefined;

  const entries = report.entries.map((entry) => {
    const task = taskMap.get(entry.taskId);
    const interactionMode = entry.interactionMode ?? task?.spec.supportedModes[0] ?? "generate";
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

    return {
      ...entry,
      interactionMode,
      weight: normalizeTargetWeight(weight),
      attemptCount,
      maxAttempts: entry.maxAttempts ?? attemptCount,
      reachedGreen,
      firstPassGreen: entry.firstPassGreen ?? (reachedGreen && attemptCount === 1),
      greenAttemptNumber,
      timeToGreenMs: entry.timeToGreenMs,
      totalDurationMs: entry.totalDurationMs ?? entry.timeToGreenMs ?? 0,
    };
  });

  return {
    ...report,
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
