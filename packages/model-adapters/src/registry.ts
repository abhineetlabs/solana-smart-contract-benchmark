import { ClaudeCodeModelAdapter, listClaudeCodeModels } from "./adapters/claude-code/index.js";
import { CodexCliModelAdapter, listCodexCliModels } from "./adapters/codex-cli/index.js";
import { MockModelAdapter, listMockModels } from "./adapters/mock/index.js";
import type { ModelAdapter } from "./types.js";

const claudeCodeAdapter = new ClaudeCodeModelAdapter();
const codexCliAdapter = new CodexCliModelAdapter();
const mockAdapter = new MockModelAdapter();

export function getAvailableModelIds(): string[] {
  return [...listMockModels(), ...listClaudeCodeModels(), ...listCodexCliModels()].sort();
}

export function getAdapterForModel(modelId: string): ModelAdapter {
  if (modelId.startsWith("mock/")) {
    return mockAdapter;
  }

  if (modelId.startsWith("claude-code/")) {
    return claudeCodeAdapter;
  }

  if (modelId.startsWith("codex/") || modelId.startsWith("codex-oss/")) {
    return codexCliAdapter;
  }

  throw new Error(`No adapter registered for model "${modelId}".`);
}
