import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadTask } from "../../core/src/index.js";
import type {
  InteractionMode,
  InvocationMode,
  TaskDescriptor,
  TaskTrackDescriptor,
} from "../../core/src/index.js";
import { getAdapterForModel } from "../../model-adapters/src/index.js";
import type { ModelResponse } from "../../model-adapters/src/index.js";
import {
  copyDirectory,
  ensureDir,
  pathExists,
  readJsonFile,
  runCommand,
  toPosixPath,
  writeJsonFile,
  writeTextFile,
} from "../../shared/src/index.js";
import { renderPrompt } from "./prompt.js";

interface RunBenchmarkArgs {
  rootDir: string;
  taskId: string;
  track: "anchor" | "native" | "pinocchio";
  modelId: string;
  mode?: InvocationMode;
  interactionMode?: InteractionMode;
  temperature?: number;
  maxOutputTokens?: number;
  keepWorkspace?: boolean;
}

interface ParsedModelOutput {
  files: Record<string, string>;
}

export interface AttemptResult {
  runId: string;
  attemptId: string;
  taskId: string;
  taskVersion: string;
  track: string;
  mode: InvocationMode;
  interactionMode: InteractionMode;
  model: {
    provider: string;
    modelId: string;
    temperature: number;
    maxOutputTokens?: number;
  };
  prompt: {
    protocolVersion: string;
    path: string;
  };
  retrieval: {
    enabled: boolean;
  };
  artifacts: {
    rawModelOutputPath: string;
    parsedFileMapPath?: string;
    workspaceSnapshotPath: string;
  };
  build: {
    success: boolean;
    durationMs: number;
    commandLogsPath: string;
  };
  tests: {
    public: {
      passed: number;
      total: number;
      commandLogsPath?: string;
    };
    hidden: {
      passed: number;
      total: number;
    };
    adversarial: {
      passed: number;
      total: number;
    };
  };
  score: {
    total: number;
    breakdown: {
      build: number;
      public: number;
      hidden: number;
      adversarial: number;
      efficiency: number;
    };
  };
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    latencyMs: number;
  };
  failureClasses: string[];
  toolchain: Record<string, string | null>;
}

export async function runBenchmark(args: RunBenchmarkArgs): Promise<{ result: AttemptResult; attemptDir: string }> {
  const mode = args.mode ?? "offline";
  const interactionMode = args.interactionMode ?? "generate";
  const temperature = args.temperature ?? 0;
  const task = await loadRequiredTask(args.rootDir, args.taskId);
  const track = loadRequiredTrack(task, args.track);

  const runId = createRunId();
  const attemptId = `${task.id}_${track.track}_${mode}_attempt1`;
  const runDir = path.join(args.rootDir, "results", runId);
  const attemptDir = path.join(runDir, "attempts", attemptId);
  const artifactsDir = path.join(attemptDir, "artifacts");
  const logsDir = path.join(attemptDir, "logs");
  await ensureDir(artifactsDir);
  await ensureDir(logsDir);

  const workspaceDir = await mkdtemp(path.join(tmpdir(), "solana-llm-benchmark-"));
  const workspaceRoot = path.join(workspaceDir, "workspace");
  await copyDirectory(track.starterDir, workspaceRoot);

  const prompt = await renderPrompt({ task, track });
  await writeTextFile(path.join(attemptDir, "prompt.txt"), prompt);
  await writeJsonFile(path.join(attemptDir, "resolved-task-spec.json"), task.spec);
  await writeJsonFile(path.join(attemptDir, "track-config.json"), track.config);

  const adapter = getAdapterForModel(args.modelId);
  const fixtureFilesJson = JSON.stringify(buildFixtureFileMap(track));
  const modelResponse = await adapter.invoke({
    modelId: args.modelId,
    prompt,
    temperature,
    maxOutputTokens: args.maxOutputTokens,
    responseFormat: "file-map-json",
    mode,
    attemptIndex: 0,
    metadata: {
      taskId: task.id,
      track: track.track,
      fixtureFilesJson,
    },
  });

  await persistModelArtifacts(attemptDir, modelResponse);
  const parsedOutput = parseAndValidateModelOutput(modelResponse, track);
  await writeJsonFile(path.join(attemptDir, "file-map.json"), parsedOutput);
  await applyModelOutput(workspaceRoot, parsedOutput);

  const workspaceExecutionRoot = path.join(workspaceRoot, track.config.workspaceRoot);
  const buildResult = await runCommand(track.config.buildCommand, workspaceExecutionRoot);
  await writeJsonFile(path.join(logsDir, "build.json"), buildResult);

  let publicPassed = 0;
  let publicTotal = 0;
  let publicLogPath = "";

  if (buildResult.success && track.config.publicTestCommand) {
    const publicResult = await runCommand(track.config.publicTestCommand, workspaceExecutionRoot);
    publicLogPath = path.join(logsDir, "public.json");
    await writeJsonFile(publicLogPath, publicResult);

    const summary = extractTestSummary(publicResult.stdout);
    publicPassed = summary.passed;
    publicTotal = summary.total;
  }

  const scoreBreakdown = computeScore(task, buildResult.success, publicPassed, publicTotal);
  await copyDirectory(workspaceRoot, path.join(artifactsDir, "workspace"));
  await writeJsonFile(path.join(attemptDir, "score.json"), scoreBreakdown);

  const toolchain = await readJsonFile<Record<string, string | null>>(
    path.join(args.rootDir, "configs", "toolchains.json"),
  );

  const result: AttemptResult = {
    runId,
    attemptId,
    taskId: task.id,
    taskVersion: task.spec.version,
    track: track.track,
    mode,
    interactionMode,
    model: {
      provider: args.modelId.split("/")[0] ?? "unknown",
      modelId: args.modelId,
      temperature,
      maxOutputTokens: args.maxOutputTokens,
    },
    prompt: {
      protocolVersion: "1.0.0",
      path: toPosixPath(path.relative(attemptDir, path.join(attemptDir, "prompt.txt"))),
    },
    retrieval: {
      enabled: mode === "retrieval",
    },
    artifacts: {
      rawModelOutputPath: toPosixPath(path.relative(attemptDir, path.join(attemptDir, "raw-output.txt"))),
      parsedFileMapPath: toPosixPath(path.relative(attemptDir, path.join(attemptDir, "file-map.json"))),
      workspaceSnapshotPath: toPosixPath(path.relative(attemptDir, path.join(artifactsDir, "workspace"))),
    },
    build: {
      success: buildResult.success,
      durationMs: buildResult.durationMs,
      commandLogsPath: toPosixPath(path.relative(attemptDir, path.join(logsDir, "build.json"))),
    },
    tests: {
      public: {
        passed: publicPassed,
        total: publicTotal,
        commandLogsPath: publicLogPath ? toPosixPath(path.relative(attemptDir, publicLogPath)) : undefined,
      },
      hidden: {
        passed: 0,
        total: 0,
      },
      adversarial: {
        passed: 0,
        total: 0,
      },
    },
    score: {
      total: scoreBreakdown.total,
      breakdown: scoreBreakdown.breakdown,
    },
    usage: {
      ...modelResponse.usage,
      latencyMs: modelResponse.latencyMs,
    },
    failureClasses: buildResult.success ? [] : ["build_error"],
    toolchain,
  };

  await writeJsonFile(path.join(attemptDir, "result.json"), result);
  await writeJsonFile(path.join(runDir, "manifest.json"), {
    runId,
    createdAt: new Date().toISOString(),
    taskId: task.id,
    track: track.track,
    modelId: args.modelId,
    attempts: [attemptId],
  });

  if (!args.keepWorkspace && (await pathExists(workspaceDir))) {
    // temp dir cleanup is intentionally skipped in the first milestone to simplify debugging.
  }

  return { result, attemptDir };
}

function buildFixtureFileMap(track: TaskTrackDescriptor): Record<string, string> {
  const output: Record<string, string> = {};

  for (const editableFile of track.config.editableFiles) {
    output[editableFile] = path.join(track.referenceSolutionDir, editableFile);
  }

  return output;
}

function parseAndValidateModelOutput(modelResponse: ModelResponse, track: TaskTrackDescriptor): ParsedModelOutput {
  const candidate = modelResponse.parsedOutput ?? parseRawText(modelResponse.rawText);

  if (!candidate || typeof candidate !== "object" || !candidate.files || Object.keys(candidate.files).length === 0) {
    throw new Error("Model output must be a non-empty JSON object with a files map.");
  }

  const editableFiles = new Set(track.config.editableFiles);

  for (const key of Object.keys(candidate.files)) {
    if (!editableFiles.has(key)) {
      throw new Error(`Model attempted to modify non-editable file: ${key}`);
    }

    if (typeof candidate.files[key] !== "string") {
      throw new Error(`Model output for ${key} must be a string.`);
    }
  }

  for (const editableFile of editableFiles) {
    if (!(editableFile in candidate.files)) {
      throw new Error(`Model output is missing required editable file: ${editableFile}`);
    }
  }

  return { files: candidate.files };
}

function parseRawText(rawText: string): ParsedModelOutput {
  return JSON.parse(rawText) as ParsedModelOutput;
}

async function applyModelOutput(workspaceRoot: string, output: ParsedModelOutput): Promise<void> {
  for (const [relativePath, content] of Object.entries(output.files)) {
    await writeTextFile(path.join(workspaceRoot, relativePath), content);
  }
}

async function persistModelArtifacts(attemptDir: string, response: ModelResponse): Promise<void> {
  await writeTextFile(path.join(attemptDir, "raw-output.txt"), response.rawText);
}

function computeScore(task: TaskDescriptor, buildSuccess: boolean, publicPassed: number, publicTotal: number) {
  const buildScore = buildSuccess ? task.spec.scoring.build : 0;
  const publicRatio = publicTotal > 0 ? publicPassed / publicTotal : 0;
  const publicScore = publicRatio * task.spec.scoring.public;
  const breakdown = {
    build: roundScore(buildScore),
    public: roundScore(publicScore),
    hidden: 0,
    adversarial: 0,
    efficiency: 0,
  };

  return {
    breakdown,
    total: roundScore(
      breakdown.build +
        breakdown.public +
        breakdown.hidden +
        breakdown.adversarial +
        breakdown.efficiency,
    ),
  };
}

function roundScore(value: number): number {
  return Number(value.toFixed(4));
}

function extractTestSummary(stdout: string): { passed: number; total: number } {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    return { passed: 0, total: 0 };
  }

  try {
    const parsed = JSON.parse(lastLine) as { passed?: number; total?: number };
    return {
      passed: parsed.passed ?? 0,
      total: parsed.total ?? 0,
    };
  } catch {
    return { passed: 0, total: 0 };
  }
}

async function loadRequiredTask(rootDir: string, taskId: string): Promise<TaskDescriptor> {
  const task = await loadTask(rootDir, taskId);
  if (!task) {
    throw new Error(`Task "${taskId}" was not found.`);
  }

  return task;
}

function loadRequiredTrack(task: TaskDescriptor, trackId: "anchor" | "native" | "pinocchio"): TaskTrackDescriptor {
  const track = task.tracks[trackId];
  if (!track) {
    throw new Error(`Task "${task.id}" does not define track "${trackId}".`);
  }

  return track;
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}_run-001`;
}
