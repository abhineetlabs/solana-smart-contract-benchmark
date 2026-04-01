import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
import { computeAttemptScore, inferFailureClasses, type StageSummary } from "../../scoring/src/index.js";
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
  status: "completed" | "failed";
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
      commandLogsPath?: string;
    };
    adversarial: {
      passed: number;
      total: number;
      commandLogsPath?: string;
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
  error?: {
    stage: string;
    message: string;
  };
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
  const sharedCargoHome = path.join(args.rootDir, ".tooling", "cargo-home");
  const sharedCargoTargetDir = path.join(args.rootDir, ".tooling", "cargo-target", task.id, track.track);
  await ensureDir(sharedCargoHome);
  await ensureDir(sharedCargoTargetDir);
  const commandEnv = {
    BENCHMARK_CARGO_HOME: sharedCargoHome,
    BENCHMARK_CARGO_TARGET_DIR: sharedCargoTargetDir,
  };

  const prompt = await renderPrompt({ task, track });
  await writeTextFile(path.join(attemptDir, "prompt.txt"), prompt);
  await writeJsonFile(path.join(attemptDir, "resolved-task-spec.json"), task.spec);
  await writeJsonFile(path.join(attemptDir, "track-config.json"), track.config);

  const workspaceExecutionRoot = path.join(workspaceRoot, track.config.workspaceRoot);
  const toolchain = await readJsonFile<Record<string, string | null>>(
    path.join(args.rootDir, "configs", "toolchains.json"),
  );

  const adapter = getAdapterForModel(args.modelId);
  const fixtureFilesJson = JSON.stringify(buildFixtureFileMap(track));
  let currentStage = "model_invoke";
  let modelResponse: ModelResponse | undefined;

  try {
    modelResponse = await adapter.invoke({
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

    currentStage = "artifact_persist";
    await persistModelArtifacts(attemptDir, modelResponse);

    currentStage = "model_output_validation";
    const parsedOutput = parseAndValidateModelOutput(modelResponse, track);
    await writeJsonFile(path.join(attemptDir, "file-map.json"), parsedOutput);

    currentStage = "workspace_apply";
    await applyModelOutput(workspaceRoot, parsedOutput);

    currentStage = "build";
    const buildResult = await runCommand(track.config.buildCommand, workspaceExecutionRoot, commandEnv);
    await writeJsonFile(path.join(logsDir, "build.json"), buildResult);

    currentStage = "public_tests";
    const publicStage = await executeStage({
      enabled: buildResult.success && Boolean(track.config.publicTestCommand),
      command: track.config.publicTestCommand,
      cwd: workspaceExecutionRoot,
      logPath: path.join(logsDir, "public.json"),
      env: commandEnv,
    });

    currentStage = "hidden_tests";
    const hiddenStage = await executeInjectedStage({
      enabled: buildResult.success && task.spec.evaluation.hiddenTests,
      sourceDir: track.hiddenTestsDir,
      targetDir: path.join(workspaceRoot, track.config.hiddenTestInjectionTarget ?? "tests"),
      command: track.config.hiddenTestCommand,
      cwd: workspaceExecutionRoot,
      logPath: path.join(logsDir, "hidden.json"),
      env: commandEnv,
    });

    currentStage = "adversarial_tests";
    const adversarialStage = await executeInjectedStage({
      enabled: buildResult.success && task.spec.evaluation.adversarialTests,
      sourceDir: track.adversarialTestsDir,
      targetDir: path.join(workspaceRoot, track.config.adversarialTestInjectionTarget ?? "tests"),
      command: track.config.adversarialTestCommand,
      cwd: workspaceExecutionRoot,
      logPath: path.join(logsDir, "adversarial.json"),
      env: commandEnv,
    });

    currentStage = "artifact_snapshot";
    const scoreBreakdown = computeAttemptScore(task.spec.scoring, buildResult.success, {
      public: publicStage.summary,
      hidden: hiddenStage.summary,
      adversarial: adversarialStage.summary,
    });
    await copyDirectory(workspaceRoot, path.join(artifactsDir, "workspace"));
    await writeJsonFile(path.join(attemptDir, "score.json"), scoreBreakdown);

    const result: AttemptResult = {
      status: "completed",
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
          passed: publicStage.summary.passed,
          total: publicStage.summary.total,
          commandLogsPath: publicStage.commandLogPath
            ? toPosixPath(path.relative(attemptDir, publicStage.commandLogPath))
            : undefined,
        },
        hidden: {
          passed: hiddenStage.summary.passed,
          total: hiddenStage.summary.total,
          commandLogsPath: hiddenStage.commandLogPath
            ? toPosixPath(path.relative(attemptDir, hiddenStage.commandLogPath))
            : undefined,
        },
        adversarial: {
          passed: adversarialStage.summary.passed,
          total: adversarialStage.summary.total,
          commandLogsPath: adversarialStage.commandLogPath
            ? toPosixPath(path.relative(attemptDir, adversarialStage.commandLogPath))
            : undefined,
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
      failureClasses: inferFailureClasses({
        buildSuccess: buildResult.success,
        buildStderr: buildResult.stderr,
        public: publicStage.summary,
        hidden: hiddenStage.summary,
        adversarial: adversarialStage.summary,
      }),
      toolchain,
    };

    await persistResultArtifacts({
      attemptDir,
      runDir,
      runId,
      attemptId,
      taskId: task.id,
      track: track.track,
      modelId: args.modelId,
      result,
    });

    if (!args.keepWorkspace && (await pathExists(workspaceDir))) {
      // temp dir cleanup is intentionally skipped in the first milestone to simplify debugging.
    }

    return { result, attemptDir };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    await copyDirectory(workspaceRoot, path.join(artifactsDir, "workspace"));

    const result: AttemptResult = {
      status: "failed",
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
        workspaceSnapshotPath: toPosixPath(path.relative(attemptDir, path.join(artifactsDir, "workspace"))),
      },
      build: {
        success: false,
        durationMs: 0,
        commandLogsPath: "",
      },
      tests: {
        public: {
          passed: 0,
          total: 0,
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
        total: 0,
        breakdown: {
          build: 0,
          public: 0,
          hidden: 0,
          adversarial: 0,
          efficiency: 0,
        },
      },
      usage: {
        ...modelResponse?.usage,
        latencyMs: modelResponse?.latencyMs ?? 0,
      },
      failureClasses: classifyRunnerError(errorMessage),
      toolchain,
      error: {
        stage: currentStage,
        message: errorMessage,
      },
    };

    await writeJsonFile(path.join(attemptDir, "score.json"), result.score);
    await writeJsonFile(path.join(attemptDir, "error.json"), result.error);
    await persistResultArtifacts({
      attemptDir,
      runDir,
      runId,
      attemptId,
      taskId: task.id,
      track: track.track,
      modelId: args.modelId,
      result,
    });

    if (!args.keepWorkspace && (await pathExists(workspaceDir))) {
      // temp dir cleanup is intentionally skipped in the first milestone to simplify debugging.
    }

    return { result, attemptDir };
  }
}

async function executeInjectedStage(args: {
  enabled: boolean;
  sourceDir: string;
  targetDir: string;
  command?: string;
  cwd: string;
  logPath: string;
  env: Record<string, string>;
}): Promise<{ summary: StageSummary; commandLogPath?: string }> {
  if (!args.enabled || !args.command) {
    return {
      summary: emptyStageSummary(),
    };
  }

  await copyDirectory(args.sourceDir, args.targetDir);
  return executeStage({
    enabled: true,
    command: args.command,
    cwd: args.cwd,
    logPath: args.logPath,
    env: args.env,
  });
}

async function executeStage(args: {
  enabled: boolean;
  command?: string;
  cwd: string;
  logPath: string;
  env: Record<string, string>;
}): Promise<{ summary: StageSummary; commandLogPath?: string }> {
  if (!args.enabled || !args.command) {
    return {
      summary: emptyStageSummary(),
    };
  }

  const result = await runCommand(args.command, args.cwd, args.env);
  await writeJsonFile(args.logPath, result);
  const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
  let summary = extractTestSummary(combinedOutput);

  if (!result.success && summary.total === 0) {
    summary = {
      passed: 0,
      total: 1,
      failures: [summarizeCommandFailure(combinedOutput)],
    };
  }

  return {
    summary,
    commandLogPath: args.logPath,
  };
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

function extractTestSummary(stdout: string): StageSummary {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    return emptyStageSummary();
  }

  try {
    const parsed = JSON.parse(lastLine) as { passed?: number; total?: number; failures?: string[] };
    return {
      passed: parsed.passed ?? 0,
      total: parsed.total ?? 0,
      failures: parsed.failures ?? [],
    };
  } catch {
    const cargoSummary = extractCargoTestSummary(stdout);
    if (cargoSummary) {
      return cargoSummary;
    }

    return emptyStageSummary();
  }
}

function emptyStageSummary(): StageSummary {
  return {
    passed: 0,
    total: 0,
    failures: [],
  };
}

function summarizeCommandFailure(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "command_failed";
  }

  return lines.slice(-10).join(" | ");
}

function extractCargoTestSummary(stdout: string): StageSummary | undefined {
  const summaryMatch = stdout.match(/test result:\s+(ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;/i);
  if (!summaryMatch) {
    return undefined;
  }

  const passed = Number(summaryMatch[2] ?? 0);
  const failed = Number(summaryMatch[3] ?? 0);
  const failures: string[] = [];

  const failureSectionMatch = stdout.match(/failures:\n([\s\S]*?)\n\ntest result:/m);
  if (failureSectionMatch?.[1]) {
    for (const line of failureSectionMatch[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "failures:") {
        continue;
      }

      failures.push(trimmed);
    }
  }

  return {
    passed,
    total: passed + failed,
    failures,
  };
}

async function persistResultArtifacts(args: {
  attemptDir: string;
  runDir: string;
  runId: string;
  attemptId: string;
  taskId: string;
  track: string;
  modelId: string;
  result: AttemptResult;
}): Promise<void> {
  await writeJsonFile(path.join(args.attemptDir, "result.json"), args.result);
  await writeJsonFile(path.join(args.runDir, "manifest.json"), {
    runId: args.runId,
    createdAt: new Date().toISOString(),
    taskId: args.taskId,
    track: args.track,
    modelId: args.modelId,
    attempts: [args.attemptId],
  });
}

function classifyRunnerError(message: string): string[] {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("json") ||
    normalized.includes("non-editable file") ||
    normalized.includes("required editable file") ||
    normalized.includes("must be a string")
  ) {
    return ["interface_mismatch"];
  }

  return ["functional_logic"];
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
  return `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
}
