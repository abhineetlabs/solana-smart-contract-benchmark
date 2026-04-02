import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadTask } from "../../core/src/index.js";
import type { CommandResult } from "../../shared/src/index.js";
import { copyDirectory, ensureDir, pathExists, runCommand, toPosixPath } from "../../shared/src/index.js";

interface WarmTaskCacheArgs {
  rootDir: string;
  taskId: string;
  track: "anchor" | "native" | "pinocchio";
}

export interface WarmTaskCacheResult {
  taskId: string;
  track: string;
  steps: Array<{
    name: string;
    success: boolean;
    durationMs: number;
    command: string;
  }>;
}

export async function warmTaskCache(args: WarmTaskCacheArgs): Promise<WarmTaskCacheResult> {
  const task = await loadTask(args.rootDir, args.taskId);
  if (!task) {
    throw new Error(`Task "${args.taskId}" was not found.`);
  }

  const track = task.tracks[args.track];
  if (!track) {
    throw new Error(`Task "${task.id}" does not define track "${args.track}".`);
  }

  const workspaceDir = await mkdtemp(path.join(tmpdir(), "solana-llm-benchmark-warm-"));
  const workspaceRoot = path.join(workspaceDir, "workspace");
  const workspaceExecutionRoot = path.join(workspaceRoot, track.config.workspaceRoot);
  const sharedCargoHome = path.join(args.rootDir, ".tooling", "cargo-home");
  const sharedCargoTargetDir = path.join(args.rootDir, ".tooling", "cargo-target", task.id, track.track);
  const env = {
    BENCHMARK_CARGO_HOME: sharedCargoHome,
    BENCHMARK_CARGO_TARGET_DIR: sharedCargoTargetDir,
  };

  try {
    await copyDirectory(track.starterDir, workspaceRoot);
    await ensureDir(sharedCargoHome);
    await ensureDir(sharedCargoTargetDir);

    const steps: WarmTaskCacheResult["steps"] = [];

    await runStep({
      steps,
      name: "build",
      command: track.config.buildCommand,
      cwd: workspaceExecutionRoot,
      env,
    });

    const publicManifestPath = path.join(workspaceRoot, "tests-public", "Cargo.toml");
    if (await pathExists(publicManifestPath)) {
      await runStep({
        steps,
        name: "public-suite",
        command: buildCargoWarmCommand({
          manifestPath: publicManifestPath,
          workspaceExecutionRoot,
          locked: true,
        }),
        cwd: workspaceExecutionRoot,
        env,
      });
    }

    await warmInjectedSuite({
      steps,
      name: "hidden-suite",
      sourceDir: track.hiddenTestsDir,
      targetDir: path.join(workspaceRoot, track.config.hiddenTestInjectionTarget ?? "tests"),
      workspaceExecutionRoot,
      env,
    });

    await warmInjectedSuite({
      steps,
      name: "adversarial-suite",
      sourceDir: track.adversarialTestsDir,
      targetDir: path.join(workspaceRoot, track.config.adversarialTestInjectionTarget ?? "tests"),
      workspaceExecutionRoot,
      env,
    });

    return {
      taskId: task.id,
      track: track.track,
      steps,
    };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function warmInjectedSuite(args: {
  steps: WarmTaskCacheResult["steps"];
  name: string;
  sourceDir: string;
  targetDir: string;
  workspaceExecutionRoot: string;
  env: Record<string, string>;
}): Promise<void> {
  if (!(await pathExists(args.sourceDir))) {
    return;
  }

  await copyDirectory(args.sourceDir, args.targetDir);
  const manifestPath = path.join(args.targetDir, "Cargo.toml");
  if (!(await pathExists(manifestPath))) {
    return;
  }

  await runStep({
    steps: args.steps,
    name: args.name,
    command: buildCargoWarmCommand({
      manifestPath,
      workspaceExecutionRoot: args.workspaceExecutionRoot,
      locked: false,
    }),
    cwd: args.workspaceExecutionRoot,
    env: args.env,
  });
}

function buildCargoWarmCommand(args: {
  manifestPath: string;
  workspaceExecutionRoot: string;
  locked: boolean;
}): string {
  const relativeManifestPath = toPosixPath(path.relative(args.workspaceExecutionRoot, args.manifestPath));
  const lockedFlag = args.locked ? " --locked" : "";

  return [
    "mkdir -p \"$BENCHMARK_CARGO_HOME\" \"$BENCHMARK_CARGO_TARGET_DIR\"",
    "source ~/.cargo/env >/dev/null 2>&1",
    "RUSTUP_TOOLCHAIN=stable CARGO_HOME=\"$BENCHMARK_CARGO_HOME\" cargo test"
      + `${lockedFlag} --manifest-path "${relativeManifestPath}" --target-dir "$BENCHMARK_CARGO_TARGET_DIR" --no-run`,
  ].join(" && ");
}

async function runStep(args: {
  steps: WarmTaskCacheResult["steps"];
  name: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<void> {
  const result = await runCommand(args.command, args.cwd, args.env);
  args.steps.push({
    name: args.name,
    success: result.success,
    durationMs: result.durationMs,
    command: args.command,
  });

  if (!result.success) {
    throw new Error(formatWarmFailure(args.name, result));
  }
}

function formatWarmFailure(stepName: string, result: CommandResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const combined = stderr || stdout || "command failed";
  return `Warm-cache step "${stepName}" failed: ${combined}`;
}
