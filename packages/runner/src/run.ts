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
  readTextFile,
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
  maxAttempts?: number;
  strictCapability?: boolean;
  runtimeRetryLimit?: number;
  keepWorkspace?: boolean;
  onProgress?: (message: string) => void;
  progressPrefix?: string;
}

interface ParsedModelOutput {
  files: Record<string, string>;
}

interface AttemptStageResult {
  summary: StageSummary;
  commandLogPath?: string;
}

export interface AttemptResult {
  status: "completed" | "failed";
  runId: string;
  attemptId: string;
  attemptNumber: number;
  maxAttempts: number;
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
      failures?: string[];
      commandLogsPath?: string;
    };
    hidden: {
      passed: number;
      total: number;
      failures?: string[];
      commandLogsPath?: string;
    };
    adversarial: {
      passed: number;
      total: number;
      failures?: string[];
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
  invocationAttempts: number;
  runtimeRetriesUsed: number;
  failureClasses: string[];
  toolchain: Record<string, string | null>;
  error?: {
    stage: string;
    message: string;
  };
}

export interface BenchmarkRunSummary {
  runId: string;
  attemptIds: string[];
  maxAttempts: number;
  attemptCount: number;
  strictCapability: boolean;
  runtimeRetryLimit: number;
  runtimeRetriesUsed: number;
  invocationCount: number;
  reachedGreen: boolean;
  firstPassGreen: boolean;
  greenAttemptNumber?: number;
  timeToGreenMs?: number;
  totalDurationMs: number;
}

export interface BenchmarkExecution {
  result: AttemptResult;
  attemptDir: string;
  run: BenchmarkRunSummary;
}

export async function runBenchmark(args: RunBenchmarkArgs): Promise<BenchmarkExecution> {
  const mode = args.mode ?? "offline";
  const temperature = args.temperature ?? 0;
  const maxAttempts = args.maxAttempts ?? 1;
  const strictCapability = args.strictCapability ?? false;
  const runtimeRetryLimit = strictCapability ? Math.max(args.runtimeRetryLimit ?? 2, 0) : 0;
  const task = await loadRequiredTask(args.rootDir, args.taskId);
  const interactionMode = args.interactionMode ?? task.spec.supportedModes[0] ?? "generate";
  const track = loadRequiredTrack(task, args.track);
  const runId = createRunId();
  const runDir = path.join(args.rootDir, "results", runId);
  const sharedCargoHome = path.join(args.rootDir, ".tooling", "cargo-home");
  const sharedCargoTargetDir = path.join(args.rootDir, ".tooling", "cargo-target", task.id, track.track);
  await ensureDir(sharedCargoHome);
  await ensureDir(sharedCargoTargetDir);
  const commandEnv = {
    BENCHMARK_CARGO_HOME: sharedCargoHome,
    BENCHMARK_CARGO_TARGET_DIR: sharedCargoTargetDir,
  };
  const toolchain = await readJsonFile<Record<string, string | null>>(
    path.join(args.rootDir, "configs", "toolchains.json"),
  );
  const basePrompt = await renderPrompt({ task, track });
  const runStartedAt = Date.now();
  const attemptIds: string[] = [];
  let previousAttempt: { result: AttemptResult; attemptDir: string } | undefined;
  let finalExecution: { result: AttemptResult; attemptDir: string } | undefined;
  let greenAttemptNumber: number | undefined;
  let timeToGreenMs: number | undefined;
  let totalRuntimeRetriesUsed = 0;
  let totalInvocationCount = 0;
  const progressPrefix = args.progressPrefix ?? `${task.id}/${track.track}`;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const attemptNumber = attemptIndex + 1;
    args.onProgress?.(
      `${progressPrefix}: attempt ${attemptNumber}/${maxAttempts} started${strictCapability ? ` (strict-capability, runtime retries ${runtimeRetryLimit})` : ""}`,
    );
    const prompt = await buildAttemptPrompt({
      basePrompt,
      previousResult: previousAttempt?.result,
      previousAttemptDir: previousAttempt?.attemptDir,
    });

    const execution = await runAttemptWithCapabilityRetries({
      rootDir: args.rootDir,
      runId,
      runDir,
      task,
      track,
      modelId: args.modelId,
      mode,
      interactionMode,
      prompt,
      temperature,
      maxOutputTokens: args.maxOutputTokens,
      attemptNumber,
      maxAttempts,
      strictCapability,
      runtimeRetryLimit,
      commandEnv,
      toolchain,
      keepWorkspace: args.keepWorkspace,
      onProgress: args.onProgress,
      progressPrefix,
    });
    attemptIds.push(execution.result.attemptId);
    totalRuntimeRetriesUsed += execution.result.runtimeRetriesUsed;
    totalInvocationCount += execution.result.invocationAttempts;
    previousAttempt = execution;
    finalExecution = execution;

    if (isGreenAttempt(execution.result)) {
      greenAttemptNumber = attemptNumber;
      timeToGreenMs = Date.now() - runStartedAt;
      args.onProgress?.(
        `${progressPrefix}: attempt ${attemptNumber}/${maxAttempts} reached green in ${formatDurationMs(timeToGreenMs)}`,
      );
      break;
    }

    args.onProgress?.(
      `${progressPrefix}: attempt ${attemptNumber}/${maxAttempts} finished with ${formatOutcomeLabel(execution.result)}`,
    );
  }

  const result = finalExecution?.result;
  const attemptDir = finalExecution?.attemptDir;
  if (!result || !attemptDir) {
    throw new Error("Benchmark run completed without producing an attempt result.");
  }

  const run: BenchmarkRunSummary = {
    runId,
    attemptIds,
    maxAttempts,
    attemptCount: attemptIds.length,
    strictCapability,
    runtimeRetryLimit,
    runtimeRetriesUsed: totalRuntimeRetriesUsed,
    invocationCount: totalInvocationCount,
    reachedGreen: greenAttemptNumber !== undefined,
    firstPassGreen: greenAttemptNumber === 1,
    greenAttemptNumber,
    timeToGreenMs,
    totalDurationMs: Date.now() - runStartedAt,
  };

  await persistRunManifest({
    runDir,
    runId,
    taskId: task.id,
    track: track.track,
    modelId: args.modelId,
    mode,
    interactionMode,
    strictCapability,
    runtimeRetryLimit,
    run,
    finalResult: result,
  });

  return {
    result,
    attemptDir,
    run,
  };
}

async function runSingleAttempt(args: {
  rootDir: string;
  runId: string;
  runDir: string;
  task: TaskDescriptor;
  track: TaskTrackDescriptor;
  modelId: string;
  mode: InvocationMode;
  interactionMode: InteractionMode;
  prompt: string;
  temperature: number;
  maxOutputTokens?: number;
  attemptNumber: number;
  invocationNumber: number;
  maxAttempts: number;
  commandEnv: Record<string, string>;
  toolchain: Record<string, string | null>;
  keepWorkspace?: boolean;
  onProgress?: (message: string) => void;
  progressPrefix: string;
}): Promise<{ result: AttemptResult; attemptDir: string }> {
  const baseAttemptId = `${args.task.id}_${args.track.track}_${args.mode}_attempt${args.attemptNumber}`;
  const attemptId =
    args.invocationNumber === 1 ? baseAttemptId : `${baseAttemptId}_invoke${args.invocationNumber}`;
  const attemptDir = path.join(args.runDir, "attempts", attemptId);
  const artifactsDir = path.join(attemptDir, "artifacts");
  const logsDir = path.join(attemptDir, "logs");
  await ensureDir(artifactsDir);
  await ensureDir(logsDir);

  const workspaceDir = await mkdtemp(path.join(tmpdir(), "solana-llm-benchmark-"));
  const workspaceRoot = path.join(workspaceDir, "workspace");
  await copyDirectory(args.track.starterDir, workspaceRoot);
  await writeTextFile(path.join(attemptDir, "prompt.txt"), args.prompt);
  await writeJsonFile(path.join(attemptDir, "resolved-task-spec.json"), args.task.spec);
  await writeJsonFile(path.join(attemptDir, "track-config.json"), args.track.config);

  const workspaceExecutionRoot = path.join(workspaceRoot, args.track.config.workspaceRoot);
  const adapter = getAdapterForModel(args.modelId);
  const fixtureFilesJson = JSON.stringify(buildFixtureFileMap(args.track));
  let currentStage = "model_invoke";
  let modelResponse: ModelResponse | undefined;

  try {
    args.onProgress?.(
      `${args.progressPrefix}: invoke ${args.invocationNumber} started`,
    );
    modelResponse = await adapter.invoke({
      modelId: args.modelId,
      prompt: args.prompt,
      temperature: args.temperature,
      maxOutputTokens: args.maxOutputTokens,
      responseFormat: "file-map-json",
      mode: args.mode,
      attemptIndex: args.attemptNumber - 1,
      metadata: {
        taskId: args.task.id,
        track: args.track.track,
        fixtureFilesJson,
      },
    });
    args.onProgress?.(
      `${args.progressPrefix}: invoke ${args.invocationNumber} completed (${formatDurationMs(modelResponse.latencyMs)})`,
    );

    currentStage = "artifact_persist";
    await persistModelArtifacts(attemptDir, modelResponse);

    currentStage = "model_output_validation";
    const parsedOutput = parseAndValidateModelOutput(modelResponse, args.track);
    await writeJsonFile(path.join(attemptDir, "file-map.json"), parsedOutput);

    currentStage = "workspace_apply";
    await applyModelOutput(workspaceRoot, parsedOutput);

    currentStage = "build";
    args.onProgress?.(
      `${args.progressPrefix}: build started (${args.track.config.buildCommand})`,
    );
    const buildResult = await runCommand(args.track.config.buildCommand, workspaceExecutionRoot, args.commandEnv);
    await writeJsonFile(path.join(logsDir, "build.json"), buildResult);
    args.onProgress?.(
      `${args.progressPrefix}: build ${buildResult.success ? "passed" : "failed"} (${formatDurationMs(buildResult.durationMs)})`,
    );

    currentStage = "public_tests";
    const publicStage = await executeStage({
      enabled: buildResult.success && Boolean(args.track.config.publicTestCommand),
      command: args.track.config.publicTestCommand,
      cwd: workspaceExecutionRoot,
      logPath: path.join(logsDir, "public.json"),
      env: args.commandEnv,
      onProgress: args.onProgress,
      progressPrefix: args.progressPrefix,
      label: "public tests",
    });

    currentStage = "hidden_tests";
    const hiddenStage = await executeInjectedStage({
      enabled: buildResult.success && args.task.spec.evaluation.hiddenTests,
      sourceDir: args.track.hiddenTestsDir,
      targetDir: path.join(workspaceRoot, args.track.config.hiddenTestInjectionTarget ?? "tests"),
      command: args.track.config.hiddenTestCommand,
      cwd: workspaceExecutionRoot,
      logPath: path.join(logsDir, "hidden.json"),
      env: args.commandEnv,
      onProgress: args.onProgress,
      progressPrefix: args.progressPrefix,
      label: "hidden tests",
    });

    currentStage = "adversarial_tests";
    const adversarialStage = await executeInjectedStage({
      enabled: buildResult.success && args.task.spec.evaluation.adversarialTests,
      sourceDir: args.track.adversarialTestsDir,
      targetDir: path.join(workspaceRoot, args.track.config.adversarialTestInjectionTarget ?? "tests"),
      command: args.track.config.adversarialTestCommand,
      cwd: workspaceExecutionRoot,
      logPath: path.join(logsDir, "adversarial.json"),
      env: args.commandEnv,
      onProgress: args.onProgress,
      progressPrefix: args.progressPrefix,
      label: "adversarial tests",
    });

    currentStage = "artifact_snapshot";
    const scoreBreakdown = computeAttemptScore(args.task.spec.scoring, buildResult.success, {
      public: publicStage.summary,
      hidden: hiddenStage.summary,
      adversarial: adversarialStage.summary,
    });
    await copyDirectory(workspaceRoot, path.join(artifactsDir, "workspace"));
    await writeJsonFile(path.join(attemptDir, "score.json"), scoreBreakdown);

    const result: AttemptResult = {
      status: "completed",
      runId: args.runId,
      attemptId,
      attemptNumber: args.attemptNumber,
      maxAttempts: args.maxAttempts,
      taskId: args.task.id,
      taskVersion: args.task.spec.version,
      track: args.track.track,
      mode: args.mode,
      interactionMode: args.interactionMode,
      model: {
        provider: args.modelId.split("/")[0] ?? "unknown",
        modelId: args.modelId,
        temperature: args.temperature,
        maxOutputTokens: args.maxOutputTokens,
      },
      prompt: {
        protocolVersion: "1.0.0",
        path: toPosixPath(path.relative(attemptDir, path.join(attemptDir, "prompt.txt"))),
      },
      retrieval: {
        enabled: args.mode === "retrieval",
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
        public: toAttemptTestStage(attemptDir, publicStage),
        hidden: toAttemptTestStage(attemptDir, hiddenStage),
        adversarial: toAttemptTestStage(attemptDir, adversarialStage),
      },
      score: {
        total: scoreBreakdown.total,
        breakdown: scoreBreakdown.breakdown,
      },
      usage: {
        ...modelResponse.usage,
        latencyMs: modelResponse.latencyMs,
      },
      invocationAttempts: 1,
      runtimeRetriesUsed: 0,
      failureClasses: inferFailureClasses({
        buildSuccess: buildResult.success,
        buildStderr: buildResult.stderr,
        public: publicStage.summary,
        hidden: hiddenStage.summary,
        adversarial: adversarialStage.summary,
      }),
      toolchain: args.toolchain,
    };

    await persistAttemptArtifacts({
      attemptDir,
      result,
    });

    args.onProgress?.(
      `${args.progressPrefix}: attempt completed with ${formatOutcomeLabel(result)}`,
    );

    if (!args.keepWorkspace && (await pathExists(workspaceDir))) {
      // temp dir cleanup is intentionally skipped in the first milestone to simplify debugging.
    }

    return { result, attemptDir };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    await copyDirectory(workspaceRoot, path.join(artifactsDir, "workspace"));

    const result: AttemptResult = {
      status: "failed",
      runId: args.runId,
      attemptId,
      attemptNumber: args.attemptNumber,
      maxAttempts: args.maxAttempts,
      taskId: args.task.id,
      taskVersion: args.task.spec.version,
      track: args.track.track,
      mode: args.mode,
      interactionMode: args.interactionMode,
      model: {
        provider: args.modelId.split("/")[0] ?? "unknown",
        modelId: args.modelId,
        temperature: args.temperature,
        maxOutputTokens: args.maxOutputTokens,
      },
      prompt: {
        protocolVersion: "1.0.0",
        path: toPosixPath(path.relative(attemptDir, path.join(attemptDir, "prompt.txt"))),
      },
      retrieval: {
        enabled: args.mode === "retrieval",
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
          failures: [],
        },
        hidden: {
          passed: 0,
          total: 0,
          failures: [],
        },
        adversarial: {
          passed: 0,
          total: 0,
          failures: [],
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
      invocationAttempts: 1,
      runtimeRetriesUsed: 0,
      failureClasses: classifyRunnerError(errorMessage),
      toolchain: args.toolchain,
      error: {
        stage: currentStage,
        message: errorMessage,
      },
    };

    await writeJsonFile(path.join(attemptDir, "score.json"), result.score);
    await writeJsonFile(path.join(attemptDir, "error.json"), result.error);
    await persistAttemptArtifacts({
      attemptDir,
      result,
    });

    args.onProgress?.(
      `${args.progressPrefix}: attempt failed at ${currentStage} (${errorMessage})`,
    );

    if (!args.keepWorkspace && (await pathExists(workspaceDir))) {
      // temp dir cleanup is intentionally skipped in the first milestone to simplify debugging.
    }

    return { result, attemptDir };
  }
}

async function buildAttemptPrompt(args: {
  basePrompt: string;
  previousResult?: AttemptResult;
  previousAttemptDir?: string;
}): Promise<string> {
  if (!args.previousResult || !args.previousAttemptDir) {
    return args.basePrompt;
  }

  const sections = [args.basePrompt.trim()];
  sections.push("## Previous Attempt Feedback");
  sections.push(`Attempt: ${args.previousResult.attemptNumber}/${args.previousResult.maxAttempts}`);
  sections.push(`Status: ${args.previousResult.status}`);
  sections.push(`Score: ${(args.previousResult.score.total * 100).toFixed(2)}/100`);
  sections.push(`Build: ${args.previousResult.build.success ? "pass" : "fail"}`);
  sections.push(
    `Tests: public ${args.previousResult.tests.public.passed}/${args.previousResult.tests.public.total}, hidden ${args.previousResult.tests.hidden.passed}/${args.previousResult.tests.hidden.total}, adversarial ${args.previousResult.tests.adversarial.passed}/${args.previousResult.tests.adversarial.total}`,
  );

  if (args.previousResult.failureClasses.length > 0) {
    sections.push(`Failure classes: ${args.previousResult.failureClasses.join(", ")}`);
  }

  if (args.previousResult.error) {
    sections.push(
      `Runner error: stage ${args.previousResult.error.stage} - ${args.previousResult.error.message}`,
    );
  }

  const stageFeedback = [
    ...formatStageFailures("Build", args.previousResult.error?.stage === "build" ? [args.previousResult.error.message] : []),
    ...formatStageFailures("Public", args.previousResult.tests.public.failures ?? []),
    ...formatStageFailures("Hidden", args.previousResult.tests.hidden.failures ?? []),
    ...formatStageFailures("Adversarial", args.previousResult.tests.adversarial.failures ?? []),
  ];

  if (stageFeedback.length > 0) {
    sections.push("### Failure Details");
    sections.push(stageFeedback.join("\n"));
  }

  const previousFileMapPath = path.join(args.previousAttemptDir, "file-map.json");
  if (await pathExists(previousFileMapPath)) {
    const previousFileMap = await readJsonFile<ParsedModelOutput>(previousFileMapPath);
    sections.push("## Previous Attempt Output");

    for (const [relativePath, content] of Object.entries(previousFileMap.files)) {
      sections.push(`### ${relativePath}`);
      sections.push("```text");
      sections.push(content.trimEnd());
      sections.push("```");
    }
  }

  sections.push("## Iteration Requirement");
  sections.push(
    "Use the feedback above to improve the solution. Return a complete replacement JSON file map for every editable file, not a diff.",
  );

  return `${sections.join("\n\n")}\n`;
}

async function executeInjectedStage(args: {
  enabled: boolean;
  sourceDir: string;
  targetDir: string;
  command?: string;
  cwd: string;
  logPath: string;
  env: Record<string, string>;
  onProgress?: (message: string) => void;
  progressPrefix: string;
  label: string;
}): Promise<{ summary: StageSummary; commandLogPath?: string }> {
  if (!args.enabled || !args.command) {
    args.onProgress?.(`${args.progressPrefix}: ${args.label} skipped`);
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
    onProgress: args.onProgress,
    progressPrefix: args.progressPrefix,
    label: args.label,
  });
}

async function executeStage(args: {
  enabled: boolean;
  command?: string;
  cwd: string;
  logPath: string;
  env: Record<string, string>;
  onProgress?: (message: string) => void;
  progressPrefix: string;
  label: string;
}): Promise<{ summary: StageSummary; commandLogPath?: string }> {
  if (!args.enabled || !args.command) {
    args.onProgress?.(`${args.progressPrefix}: ${args.label} skipped`);
    return {
      summary: emptyStageSummary(),
    };
  }

  args.onProgress?.(`${args.progressPrefix}: ${args.label} started (${args.command})`);
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

  args.onProgress?.(
    `${args.progressPrefix}: ${args.label} ${result.success ? "finished" : "failed"} (${summary.passed}/${summary.total}, ${formatDurationMs(result.durationMs)})`,
  );

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

async function persistAttemptArtifacts(args: {
  attemptDir: string;
  result: AttemptResult;
}): Promise<void> {
  await writeJsonFile(path.join(args.attemptDir, "result.json"), args.result);
}

async function persistRunManifest(args: {
  runDir: string;
  runId: string;
  taskId: string;
  track: string;
  modelId: string;
  mode: InvocationMode;
  interactionMode: InteractionMode;
  strictCapability: boolean;
  runtimeRetryLimit: number;
  run: BenchmarkRunSummary;
  finalResult: AttemptResult;
}): Promise<void> {
  await writeJsonFile(path.join(args.runDir, "manifest.json"), {
    runId: args.runId,
    createdAt: new Date().toISOString(),
    taskId: args.taskId,
    track: args.track,
    modelId: args.modelId,
    mode: args.mode,
    interactionMode: args.interactionMode,
    strictCapability: args.strictCapability,
    runtimeRetryLimit: args.runtimeRetryLimit,
    maxAttempts: args.run.maxAttempts,
    attemptCount: args.run.attemptCount,
    invocationCount: args.run.invocationCount,
    runtimeRetriesUsed: args.run.runtimeRetriesUsed,
    attempts: args.run.attemptIds,
    reachedGreen: args.run.reachedGreen,
    firstPassGreen: args.run.firstPassGreen,
    greenAttemptNumber: args.run.greenAttemptNumber,
    timeToGreenMs: args.run.timeToGreenMs,
    totalDurationMs: args.run.totalDurationMs,
    finalAttemptId: args.finalResult.attemptId,
    finalStatus: args.finalResult.status,
    finalScore: args.finalResult.score.total,
  });
}

async function runAttemptWithCapabilityRetries(args: {
  rootDir: string;
  runId: string;
  runDir: string;
  task: TaskDescriptor;
  track: TaskTrackDescriptor;
  modelId: string;
  mode: InvocationMode;
  interactionMode: InteractionMode;
  prompt: string;
  temperature: number;
  maxOutputTokens?: number;
  attemptNumber: number;
  maxAttempts: number;
  strictCapability: boolean;
  runtimeRetryLimit: number;
  commandEnv: Record<string, string>;
  toolchain: Record<string, string | null>;
  keepWorkspace?: boolean;
  onProgress?: (message: string) => void;
  progressPrefix: string;
}): Promise<{ result: AttemptResult; attemptDir: string }> {
  let invocationNumber = 0;
  let finalExecution: { result: AttemptResult; attemptDir: string } | undefined;

  while (invocationNumber <= args.runtimeRetryLimit) {
    invocationNumber += 1;

    const execution = await runSingleAttempt({
      ...args,
      invocationNumber,
    });
    finalExecution = execution;

    const shouldRetry =
      args.strictCapability &&
      execution.result.error?.stage === "model_invoke" &&
      invocationNumber <= args.runtimeRetryLimit;

    if (!shouldRetry) {
      break;
    }

    args.onProgress?.(
      `${args.progressPrefix}: model invoke failed, retrying provider call ${invocationNumber + 1}/${args.runtimeRetryLimit + 1}`,
    );
  }

  if (!finalExecution) {
    throw new Error("Capability retry loop finished without producing an attempt result.");
  }

  const invocationAttempts = invocationNumber;
  const runtimeRetriesUsed = Math.max(invocationAttempts - 1, 0);
  finalExecution.result.invocationAttempts = invocationAttempts;
  finalExecution.result.runtimeRetriesUsed = runtimeRetriesUsed;
  await persistAttemptArtifacts({
    attemptDir: finalExecution.attemptDir,
    result: finalExecution.result,
  });

  return finalExecution;
}

function toAttemptTestStage(
  attemptDir: string,
  stage: AttemptStageResult,
): {
  passed: number;
  total: number;
  failures?: string[];
  commandLogsPath?: string;
} {
  return {
    passed: stage.summary.passed,
    total: stage.summary.total,
    failures: stage.summary.failures,
    commandLogsPath: stage.commandLogPath
      ? toPosixPath(path.relative(attemptDir, stage.commandLogPath))
      : undefined,
  };
}

function formatStageFailures(stage: string, failures: string[]): string[] {
  return failures.map((failure) => `- ${stage}: ${failure}`);
}

function isGreenAttempt(result: AttemptResult): boolean {
  return result.status === "completed" && result.score.total >= 0.9999;
}

function formatDurationMs(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return "-";
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatOutcomeLabel(result: AttemptResult): string {
  if (result.error?.stage === "model_invoke") {
    return "runtime exclusion";
  }

  return `${(result.score.total * 100).toFixed(2)}/100`;
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
