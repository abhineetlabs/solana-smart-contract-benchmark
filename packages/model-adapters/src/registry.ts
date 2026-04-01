import { MockModelAdapter, listMockModels } from "./adapters/mock/index.js";
import type { ModelAdapter } from "./types.js";

const mockAdapter = new MockModelAdapter();

export function getAvailableModelIds(): string[] {
  return listMockModels();
}

export function getAdapterForModel(modelId: string): ModelAdapter {
  if (modelId.startsWith("mock/")) {
    return mockAdapter;
  }

  throw new Error(`No adapter registered for model "${modelId}".`);
}
