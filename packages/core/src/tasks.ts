import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { pathExists, readJsonFile } from "../../shared/src/index.js";
import { validateTaskDescriptor } from "./validation.js";
import type {
  TaskDescriptor,
  TaskSpec,
  TaskTrackDescriptor,
  TrackConfig,
  TrackId,
  ValidationResult,
} from "./types.js";

export async function discoverTasks(rootDir: string): Promise<TaskDescriptor[]> {
  const tasksDir = path.join(rootDir, "tasks");
  if (!(await pathExists(tasksDir))) {
    return [];
  }

  const taskEntries = await readdir(tasksDir, { withFileTypes: true });
  const taskDescriptors: TaskDescriptor[] = [];

  for (const entry of taskEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const taskRoot = path.join(tasksDir, entry.name);
    const coreDir = path.join(taskRoot, "core");
    const specPath = path.join(coreDir, "spec.json");

    if (!(await pathExists(specPath))) {
      continue;
    }

    const spec = await readJsonFile<TaskSpec>(specPath);
    const promptPath = path.join(coreDir, "prompt.md");
    const rubricPath = path.join(coreDir, "rubric.json");
    const tracks: Partial<Record<TrackId, TaskTrackDescriptor>> = {};

    for (const track of spec.supportedTracks) {
      const trackRoot = path.join(taskRoot, track);
      const trackConfigPath = path.join(trackRoot, "track.config.json");
      if (!(await pathExists(trackConfigPath))) {
        continue;
      }

      const config = await readJsonFile<TrackConfig>(trackConfigPath);

      tracks[track] = {
        track,
        rootDir: trackRoot,
        starterDir: path.join(trackRoot, "starter"),
        trackConfigPath,
        publicTestsDir: path.join(trackRoot, "tests-public"),
        hiddenTestsDir: path.join(trackRoot, "tests-hidden"),
        adversarialTestsDir: path.join(trackRoot, "tests-adversarial"),
        referenceSolutionDir: path.join(trackRoot, "reference-solution"),
        insecureSolutionDir: path.join(trackRoot, "insecure-solution"),
        config,
      };
    }

    taskDescriptors.push({
      id: spec.id,
      rootDir: taskRoot,
      coreDir,
      specPath,
      promptPath,
      rubricPath,
      spec,
      tracks,
    });
  }

  return taskDescriptors.sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadTask(rootDir: string, taskId: string): Promise<TaskDescriptor | undefined> {
  const tasks = await discoverTasks(rootDir);
  return tasks.find((task) => task.id === taskId);
}

export async function readTaskPrompt(task: TaskDescriptor): Promise<string> {
  if (!(await pathExists(task.promptPath))) {
    return "";
  }

  return readFile(task.promptPath, "utf8");
}

export async function validateAllTasks(rootDir: string): Promise<ValidationResult> {
  const tasks = await discoverTasks(rootDir);
  const issues: string[] = [];
  const seenIds = new Set<string>();

  for (const task of tasks) {
    if (seenIds.has(task.id)) {
      issues.push(`Duplicate task id detected: ${task.id}`);
      continue;
    }

    seenIds.add(task.id);
    issues.push(...(await validateTaskDescriptor(task)));
  }

  return {
    ok: issues.length === 0,
    tasks,
    issues,
  };
}
