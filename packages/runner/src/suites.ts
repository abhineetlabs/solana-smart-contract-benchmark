import { readdir } from "node:fs/promises";
import path from "node:path";

import { pathExists, readJsonFile } from "../../shared/src/index.js";

export interface BenchmarkSuiteTarget {
  taskId: string;
  track: "anchor" | "native" | "pinocchio";
  weight?: number;
}

export interface BenchmarkSuite {
  id: string;
  title: string;
  description: string;
  targets: BenchmarkSuiteTarget[];
}

export async function listAvailableSuites(rootDir: string): Promise<BenchmarkSuite[]> {
  const suitesDir = path.join(rootDir, "configs", "suites");
  if (!(await pathExists(suitesDir))) {
    return [];
  }

  const entries = await readdir(suitesDir, { withFileTypes: true });
  const suites: BenchmarkSuite[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const suiteId = entry.name.replace(/\.json$/u, "");
    suites.push(await loadBenchmarkSuite(rootDir, suiteId));
  }

  return suites.sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadBenchmarkSuite(rootDir: string, suiteId: string): Promise<BenchmarkSuite> {
  const suitePath = path.join(rootDir, "configs", "suites", `${suiteId}.json`);
  if (!(await pathExists(suitePath))) {
    throw new Error(`Unknown benchmark suite "${suiteId}".`);
  }

  const suite = await readJsonFile<BenchmarkSuite>(suitePath);
  if (!suite.id || !suite.title || !Array.isArray(suite.targets) || suite.targets.length === 0) {
    throw new Error(`Benchmark suite "${suiteId}" is invalid.`);
  }

  for (const target of suite.targets) {
    if (target.weight !== undefined && (!Number.isFinite(target.weight) || target.weight <= 0)) {
      throw new Error(
        `Benchmark suite "${suiteId}" contains an invalid weight for "${target.taskId}/${target.track}".`,
      );
    }
  }

  return suite;
}
