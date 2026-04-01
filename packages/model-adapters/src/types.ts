export type ModelInvocationMode = "offline" | "retrieval";

export interface RetrievedChunk {
  documentId: string;
  title: string;
  text: string;
}

export interface ModelRequest {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  temperature: number;
  maxOutputTokens?: number;
  responseFormat: "file-map-json";
  mode: ModelInvocationMode;
  retrievalContext?: RetrievedChunk[];
  attemptIndex: number;
  metadata: Record<string, string | number | boolean>;
}

export interface ModelResponse {
  rawText: string;
  parsedOutput?: {
    files: Record<string, string>;
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
  };
  latencyMs: number;
  finishReason?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelAdapter {
  id: string;
  invoke(request: ModelRequest): Promise<ModelResponse>;
}
