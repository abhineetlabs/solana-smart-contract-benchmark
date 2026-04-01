import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import type {
  ScoreWeights,
  TaskDescriptor,
  TaskSpec,
  TrackConfig,
  TrackId,
} from "./types.js";

const TRACKS: TrackId[] = ["anchor", "native", "pinocchio"];
const DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const MODES = new Set(["generate", "complete", "repair", "modify", "migrate"]);

export async function validateTaskDescriptor(task: TaskDescriptor): Promise<string[]> {
  const issues: string[] = [];

  validateTaskSpecShape(task.spec, issues, task.specPath);
  validateScoring(task.spec.scoring, issues, task.specPath);

  const seenTracks = new Set<string>();

  for (const supportedTrack of task.spec.supportedTracks) {
    if (seenTracks.has(supportedTrack)) {
      issues.push(`${task.id}: duplicate supported track "${supportedTrack}".`);
      continue;
    }

    seenTracks.add(supportedTrack);

    const descriptor = task.tracks[supportedTrack];
    if (!descriptor) {
      issues.push(`${task.id}: missing folder/config for supported track "${supportedTrack}".`);
      continue;
    }

    validateTrackConfig(task, supportedTrack, descriptor.config, issues);
    await validateEditableFiles(task, supportedTrack, descriptor.starterDir, descriptor.config.editableFiles, issues);
    await validateTrackEvaluationFiles(task, supportedTrack, descriptor, issues);
  }

  return issues;
}

function validateTaskSpecShape(spec: TaskSpec, issues: string[], source: string): void {
  if (!spec.id || !/^[a-z0-9_]+$/.test(spec.id)) {
    issues.push(`${source}: task id must match ^[a-z0-9_]+$.`);
  }

  if (!DIFFICULTIES.has(spec.difficulty)) {
    issues.push(`${source}: invalid difficulty "${spec.difficulty}".`);
  }

  if (spec.supportedTracks.length === 0) {
    issues.push(`${source}: supportedTracks cannot be empty.`);
  }

  for (const track of spec.supportedTracks) {
    if (!TRACKS.includes(track)) {
      issues.push(`${source}: invalid supported track "${track}".`);
    }
  }

  for (const mode of spec.supportedModes) {
    if (!MODES.has(mode)) {
      issues.push(`${source}: invalid supported mode "${mode}".`);
    }
  }

  if (spec.instructions.length === 0) {
    issues.push(`${source}: instructions cannot be empty.`);
  }

  if (spec.editableFiles.length === 0) {
    issues.push(`${source}: editableFiles cannot be empty.`);
  }
}

function validateScoring(scoring: ScoreWeights, issues: string[], source: string): void {
  const total =
    scoring.build +
    scoring.public +
    scoring.hidden +
    scoring.adversarial +
    scoring.efficiency;

  if (Math.abs(total - 1) > 0.0001) {
    issues.push(`${source}: scoring weights must sum to 1.0, got ${total.toFixed(4)}.`);
  }
}

function validateTrackConfig(
  task: TaskDescriptor,
  track: TrackId,
  config: TrackConfig,
  issues: string[],
): void {
  if (!config.buildCommand) {
    issues.push(`${task.id}/${track}: buildCommand is required.`);
  }

  if (!config.workspaceRoot) {
    issues.push(`${task.id}/${track}: workspaceRoot is required.`);
  }

  if (!Array.isArray(config.editableFiles) || config.editableFiles.length === 0) {
    issues.push(`${task.id}/${track}: editableFiles cannot be empty.`);
  }

  const specFiles = new Set(task.spec.editableFiles);
  for (const editableFile of config.editableFiles) {
    if (!specFiles.has(editableFile)) {
      issues.push(`${task.id}/${track}: editable file "${editableFile}" is not declared in core spec.`);
    }
  }
}

async function validateEditableFiles(
  task: TaskDescriptor,
  track: TrackId,
  starterDir: string,
  editableFiles: string[],
  issues: string[],
): Promise<void> {
  for (const editableFile of editableFiles) {
    const absolutePath = path.join(starterDir, editableFile);
    try {
      await access(absolutePath, constants.F_OK);
    } catch {
      issues.push(`${task.id}/${track}: editable file is missing from starter scaffold: ${editableFile}`);
    }
  }
}

async function validateTrackEvaluationFiles(
  task: TaskDescriptor,
  track: TrackId,
  descriptor: TaskDescriptor["tracks"][TrackId],
  issues: string[],
): Promise<void> {
  if (!descriptor) {
    return;
  }

  if (task.spec.evaluation.publicTests) {
    if (!descriptor.config.publicTestCommand) {
      issues.push(`${task.id}/${track}: publicTestCommand is required when publicTests is enabled.`);
    }

    await requirePath(descriptor.publicTestsDir, `${task.id}/${track}: tests-public directory is missing.`, issues);
  }

  if (task.spec.evaluation.hiddenTests) {
    if (!descriptor.config.hiddenTestCommand) {
      issues.push(`${task.id}/${track}: hiddenTestCommand is required when hiddenTests is enabled.`);
    }

    await requirePath(descriptor.hiddenTestsDir, `${task.id}/${track}: tests-hidden directory is missing.`, issues);
  }

  if (task.spec.evaluation.adversarialTests) {
    if (!descriptor.config.adversarialTestCommand) {
      issues.push(`${task.id}/${track}: adversarialTestCommand is required when adversarialTests is enabled.`);
    }

    await requirePath(
      descriptor.adversarialTestsDir,
      `${task.id}/${track}: tests-adversarial directory is missing.`,
      issues,
    );
  }
}

async function requirePath(targetPath: string, issue: string, issues: string[]): Promise<void> {
  try {
    await access(targetPath, constants.F_OK);
  } catch {
    issues.push(issue);
  }
}
