import { readFile } from "node:fs/promises";

import type { ModelAdapter, ModelRequest, ModelResponse } from "../../types.js";

const MOCK_MODELS = new Set(["mock/reference", "mock/insecure", "mock/invalid-json", "mock/starter"]);

export class MockModelAdapter implements ModelAdapter {
  readonly id = "mock";

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();

    if (!MOCK_MODELS.has(request.modelId)) {
      throw new Error(`Unsupported mock model id: ${request.modelId}`);
    }

    if (request.modelId === "mock/invalid-json") {
      return {
        rawText: "{ invalid json",
        latencyMs: Date.now() - startedAt,
        finishReason: "stop",
      };
    }

    const fixtureMapJson = request.metadata.fixtureFilesJson;
    if (typeof fixtureMapJson !== "string") {
      throw new Error("Mock adapter requires metadata.fixtureFilesJson.");
    }

    const fixtureMap = JSON.parse(fixtureMapJson) as Record<string, string>;
    const files: Record<string, string> = {};

    for (const [targetPath, sourcePath] of Object.entries(fixtureMap)) {
      files[targetPath] = await resolveContent(request.modelId, sourcePath);
    }

    const rawText = JSON.stringify({ files }, null, 2);

    return {
      rawText,
      parsedOutput: { files },
      latencyMs: Date.now() - startedAt,
      finishReason: "stop",
      reasoningEffort: request.reasoningEffort ?? "default",
      providerReasoningEffort: request.reasoningEffort ?? "default",
      usage: {
        promptTokens: Math.ceil(request.prompt.length / 4),
        completionTokens: Math.ceil(rawText.length / 4),
        totalTokens: Math.ceil((request.prompt.length + rawText.length) / 4),
        estimatedCostUsd: 0,
      },
      providerMetadata: {
        mockModelId: request.modelId,
      },
    };
  }
}

async function resolveContent(modelId: string, defaultFixturePath: string): Promise<string> {
  if (modelId === "mock/reference") {
    return readFile(defaultFixturePath, "utf8");
  }

  if (modelId === "mock/insecure") {
    return readFile(defaultFixturePath.replace("/reference-solution/", "/insecure-solution/"), "utf8");
  }

  if (modelId === "mock/starter") {
    return readFile(defaultFixturePath.replace("/reference-solution/", "/starter/"), "utf8");
  }

  return readFile(defaultFixturePath, "utf8");
}

export function listMockModels(): string[] {
  return [...MOCK_MODELS].sort();
}
