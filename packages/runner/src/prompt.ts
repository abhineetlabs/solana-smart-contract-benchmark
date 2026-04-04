import path from "node:path";

import { readTaskPrompt } from "../../core/src/index.js";
import type { TaskDescriptor, TaskTrackDescriptor } from "../../core/src/index.js";
import { FILE_MAP_OUTPUT_FORMAT_LINES, listRelativeFiles, pathExists, readTextFile } from "../../shared/src/index.js";

export interface PromptRenderInput {
  task: TaskDescriptor;
  track: TaskTrackDescriptor;
}

export async function renderPrompt(input: PromptRenderInput): Promise<string> {
  const { task, track } = input;
  const promptSections: string[] = [];
  const taskPrompt = await readTaskPrompt(task);

  promptSections.push(`# Task: ${task.spec.title}`);
  promptSections.push(`Task ID: ${task.id}`);
  promptSections.push(`Track: ${track.track}`);
  promptSections.push(`Summary: ${task.spec.summary}`);

  promptSections.push("## Instructions");
  promptSections.push(task.spec.instructions.map((instruction) => `- ${instruction.name}: ${instruction.description}`).join("\n"));

  promptSections.push("## Invariants");
  promptSections.push(task.spec.invariants.map((invariant) => `- ${invariant}`).join("\n"));

  promptSections.push("## Editable Files");
  promptSections.push(track.config.editableFiles.map((editableFile) => `- ${editableFile}`).join("\n"));

  if (taskPrompt.trim().length > 0) {
    promptSections.push("## Task Notes");
    promptSections.push(taskPrompt.trim());
  }

  if (task.spec.promptAssets.includeStarterTree) {
    promptSections.push("## Starter File Tree");
    const tree = await listRelativeFiles(track.starterDir);
    promptSections.push(tree.map((relativePath) => `- ${relativePath}`).join("\n"));
  }

  if (task.spec.promptAssets.includeEditableFileContents) {
    promptSections.push("## Editable File Contents");
    for (const editableFile of track.config.editableFiles) {
      const absolutePath = path.join(track.starterDir, editableFile);
      if (!(await pathExists(absolutePath))) {
        continue;
      }

      const content = await readTextFile(absolutePath);
      promptSections.push(`### ${editableFile}`);
      promptSections.push("```text");
      promptSections.push(content.trimEnd());
      promptSections.push("```");
    }
  }

  if (task.spec.promptAssets.includePublicTests && (await pathExists(track.publicTestsDir))) {
    const publicTests = await listRelativeFiles(track.publicTestsDir);
    if (publicTests.length > 0) {
      promptSections.push("## Public Tests");
      for (const publicTest of publicTests) {
        const absolutePath = path.join(track.publicTestsDir, publicTest);
        const content = await readTextFile(absolutePath);
        promptSections.push(`### ${publicTest}`);
        promptSections.push("```text");
        promptSections.push(content.trimEnd());
        promptSections.push("```");
      }
    }
  }

  if (task.spec.promptAssets.includeCommands) {
    promptSections.push("## Evaluation Commands");
    promptSections.push(`- Build: ${track.config.buildCommand}`);
    if (track.config.publicTestCommand) {
      promptSections.push(`- Public tests: ${track.config.publicTestCommand}`);
    }
  }

  promptSections.push("## Output Format");
  promptSections.push(...FILE_MAP_OUTPUT_FORMAT_LINES);

  return `${promptSections.join("\n\n")}\n`;
}
