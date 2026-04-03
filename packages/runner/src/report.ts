import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  discoverTasks,
  type Difficulty,
  type InvocationMode,
  type TrackId,
} from "../../core/src/index.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from "../../shared/src/index.js";
import { runBenchmark, type AttemptResult } from "./run.js";
import { loadBenchmarkSuite } from "./suites.js";
import { warmTaskCache } from "./warm.js";

export interface BenchmarkTarget {
  taskId: string;
  track: TrackId;
  category: string;
  difficulty: Difficulty;
  title: string;
  weight: number;
}

export interface SweepEntry {
  taskId: string;
  track: TrackId;
  category: string;
  difficulty: Difficulty;
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
}

export interface SweepSummary {
  totalTargets: number;
  totalWeight: number;
  completedTargets: number;
  failedTargets: number;
  buildPassedTargets: number;
  averageScore: number;
}

export interface SweepReport {
  sweepId: string;
  createdAt: string;
  modelId: string;
  mode: InvocationMode;
  warmed: boolean;
  suiteId?: string;
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

      return {
        taskId: task.id,
        track: target.track,
        category: task.spec.category,
        difficulty: task.spec.difficulty,
        title: task.spec.title,
        weight: normalizeTargetWeight(target.weight ?? defaultDifficultyWeight(task.spec.difficulty)),
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
    });

    entries.push(toSweepEntry(target, args.rootDir, execution.result, execution.attemptDir));
  }

  const report: SweepReport = {
    sweepId,
    createdAt: new Date().toISOString(),
    modelId: args.modelId,
    mode,
    warmed: args.warmCache ?? false,
    suiteId: args.suiteId,
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
  result: AttemptResult,
  attemptDir: string,
): SweepEntry {
  return {
    taskId: target.taskId,
    track: target.track,
    category: target.category,
    difficulty: target.difficulty,
    title: target.title,
    weight: target.weight,
    runId: result.runId,
    attemptId: result.attemptId,
    status: result.status,
    score: result.score.total,
    buildSuccess: result.build.success,
    tests: result.tests,
    failureClasses: result.failureClasses,
    resultPath: path.relative(rootDir, path.join(attemptDir, "result.json")),
    attemptDir: path.relative(rootDir, attemptDir),
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
    averageScore: totalWeight === 0 ? 0 : roundScore(totalScore / totalWeight),
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
  const suiteWeightMap = report.suiteId
    ? await loadSuiteWeightMap(rootDir, report.suiteId).catch(() => undefined)
    : undefined;
  const entries = report.entries.map((entry) => ({
    ...entry,
    weight: normalizeTargetWeight(
      entry.weight ??
        suiteWeightMap?.get(`${entry.taskId}/${entry.track}`) ??
        defaultDifficultyWeight(entry.difficulty),
    ),
  }));

  return {
    ...report,
    entries,
    summary: computeSweepSummary(entries),
  };
}

async function loadSuiteWeightMap(rootDir: string, suiteId: string): Promise<Map<string, number>> {
  const suite = await loadBenchmarkSuite(rootDir, suiteId);
  const weights = new Map<string, number>();

  for (const target of suite.targets) {
    if (target.weight !== undefined) {
      weights.set(`${target.taskId}/${target.track}`, normalizeTargetWeight(target.weight));
    }
  }

  return weights;
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

function normalizeTargetWeight(weight: number): number {
  return roundWeight(weight);
}

function roundScore(value: number): number {
  return Number(value.toFixed(4));
}

function roundWeight(value: number): number {
  return Number(value.toFixed(2));
}
