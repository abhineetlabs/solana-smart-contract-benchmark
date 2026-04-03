import { readdir } from "node:fs/promises";
import path from "node:path";

import type { Difficulty, InteractionMode, TrackId } from "../../core/src/index.js";
import { pathExists, readJsonFile, toPosixPath } from "../../shared/src/index.js";

export interface BenchmarkSuiteTarget {
  taskId: string;
  track: TrackId;
  weight?: number;
}

export interface BenchmarkSuiteWeightRules {
  base?: number;
  difficulty?: Partial<Record<Difficulty, number>>;
  interactionMode?: Partial<Record<InteractionMode, number>>;
  track?: Partial<Record<TrackId, number>>;
  category?: Record<string, number>;
}

export interface BenchmarkSuite {
  id: string;
  title: string;
  description: string;
  tags?: string[];
  weightRules?: BenchmarkSuiteWeightRules;
  targets: BenchmarkSuiteTarget[];
}

export async function listAvailableSuites(rootDir: string): Promise<BenchmarkSuite[]> {
  const suiteFiles = await listSuiteFilePaths(rootDir);
  const suites = await Promise.all(suiteFiles.map((filePath) => loadSuiteFile(filePath)));
  const seenIds = new Set<string>();

  for (const suite of suites) {
    if (seenIds.has(suite.id)) {
      throw new Error(`Duplicate benchmark suite id "${suite.id}" detected.`);
    }

    seenIds.add(suite.id);
  }

  return suites.sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadBenchmarkSuite(rootDir: string, suiteId: string): Promise<BenchmarkSuite> {
  const suiteFiles = await listSuiteFilePaths(rootDir);
  const matches: BenchmarkSuite[] = [];

  for (const filePath of suiteFiles) {
    const suite = await loadSuiteFile(filePath);
    const relativeId = toSuiteRelativeId(rootDir, filePath);

    if (suite.id === suiteId || relativeId === suiteId) {
      matches.push(suite);
    }
  }

  if (matches.length === 0) {
    throw new Error(`Unknown benchmark suite "${suiteId}".`);
  }

  if (matches.length > 1) {
    throw new Error(`Benchmark suite "${suiteId}" is ambiguous across multiple files.`);
  }

  const [suite] = matches;
  if (!suite) {
    throw new Error(`Unknown benchmark suite "${suiteId}".`);
  }

  return suite;
}

async function listSuiteFilePaths(rootDir: string): Promise<string[]> {
  const suitesDir = path.join(rootDir, "configs", "suites");
  if (!(await pathExists(suitesDir))) {
    return [];
  }

  const output: string[] = [];
  await walkSuiteDir(suitesDir, output);
  return output.sort();
}

async function walkSuiteDir(currentDir: string, output: string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      await walkSuiteDir(entryPath, output);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".example.json")) {
      continue;
    }

    output.push(entryPath);
  }
}

async function loadSuiteFile(filePath: string): Promise<BenchmarkSuite> {
  const suite = await readJsonFile<BenchmarkSuite>(filePath);
  validateSuite(suite, filePath);
  return suite;
}

function validateSuite(suite: BenchmarkSuite, sourcePath: string): void {
  if (!suite.id || !suite.title || !Array.isArray(suite.targets) || suite.targets.length === 0) {
    throw new Error(`Benchmark suite "${sourcePath}" is invalid.`);
  }

  if (suite.tags && (!Array.isArray(suite.tags) || suite.tags.some((tag) => typeof tag !== "string" || tag.length === 0))) {
    throw new Error(`Benchmark suite "${suite.id}" contains invalid tags.`);
  }

  validatePositiveNumber(suite.weightRules?.base, suite.id, "weightRules.base");
  validateWeightRecord(suite.id, "weightRules.difficulty", suite.weightRules?.difficulty);
  validateWeightRecord(suite.id, "weightRules.interactionMode", suite.weightRules?.interactionMode);
  validateWeightRecord(suite.id, "weightRules.track", suite.weightRules?.track);
  validateWeightRecord(suite.id, "weightRules.category", suite.weightRules?.category);

  for (const target of suite.targets) {
    validatePositiveNumber(target.weight, suite.id, `${target.taskId}/${target.track}`);
  }
}

function validateWeightRecord(
  suiteId: string,
  label: string,
  record?: Record<string, number | undefined>,
): void {
  if (!record) {
    return;
  }

  for (const [key, value] of Object.entries(record)) {
    validatePositiveNumber(value, suiteId, `${label}.${key}`);
  }
}

function validatePositiveNumber(value: number | undefined, suiteId: string, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Benchmark suite "${suiteId}" contains an invalid positive weight for "${label}".`);
  }
}

function toSuiteRelativeId(rootDir: string, filePath: string): string {
  const suitesDir = path.join(rootDir, "configs", "suites");
  return toPosixPath(path.relative(suitesDir, filePath).replace(/\.json$/u, ""));
}
