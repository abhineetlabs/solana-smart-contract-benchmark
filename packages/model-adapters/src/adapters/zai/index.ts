import { randomUUID } from "node:crypto";

import { FILE_MAP_OUTPUT_FORMAT_LINES, tryParseFileMapOutputFromText } from "../../../../shared/src/index.js";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../../types.js";

const ZAI_PREFIX = "zai/";
const DEFAULT_ZAI_MODEL = "glm-5.1";
const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
const DEFAULT_ZAI_TIMEOUT_MS = 15 * 60 * 1000;
const KNOWN_ZAI_MODELS = ["zai/default", "zai/glm-5.1"] as const;
const DEFAULT_USER_ID = "solana-benchmark";

interface ZaiChatMessage {
  role: "system" | "user";
  content: string;
}

interface ZaiChatCompletionRequest {
  model: string;
  messages: ZaiChatMessage[];
  stream: false;
  do_sample: boolean;
  temperature: number;
  max_tokens?: number;
  request_id: string;
  user_id: string;
  response_format: {
    type: "json_object";
  };
}

interface ZaiChatCompletionResponse {
  id?: string;
  request_id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string;
    message?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: unknown[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
}

export class ZaiModelAdapter implements ModelAdapter {
  readonly id = "zai";

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (!request.modelId.startsWith(ZAI_PREFIX)) {
      throw new Error(`Unsupported Z.AI model id: ${request.modelId}`);
    }

    if (request.reasoningEffort && request.reasoningEffort !== "default") {
      throw new Error(
        `Z.AI direct adapter does not support configurable reasoning effort. Remove --reasoning-effort or use a supported adapter.`,
      );
    }

    const apiKey = await resolveZaiApiKey();
    const baseUrl = resolveZaiBaseUrl();
    const timeoutMs = resolveZaiTimeoutMs();
    const forwardedModel = resolveZaiModelId(request.modelId);
    const startedAt = Date.now();

    const completion = await invokeZaiChatCompletion({
      apiKey,
      baseUrl,
      timeoutMs,
      body: buildZaiRequestBody({
        model: forwardedModel,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
      }),
    });

    return {
      rawText: completion.rawText,
      parsedOutput: tryParseFileMapOutputFromText(completion.rawText),
      latencyMs: Date.now() - startedAt,
      finishReason: completion.finishReason ?? "stop",
      reasoningEffort: request.reasoningEffort ?? "default",
      providerReasoningEffort: "default",
      usage: completion.usage,
      providerMetadata: {
        provider: "zai",
        baseUrl,
        forwardedModel,
        responseModel: completion.responseModel,
        requestId: completion.requestId,
        responseId: completion.responseId,
      },
    };
  }
}

export function listZaiModels(): string[] {
  return [...KNOWN_ZAI_MODELS];
}

export function resolveZaiModelId(modelId: string): string {
  const suffix = modelId.slice(ZAI_PREFIX.length).trim();
  if (!suffix || suffix === "default") {
    return DEFAULT_ZAI_MODEL;
  }

  return suffix;
}

export function buildZaiRequestBody(args: {
  model: string;
  prompt: string;
  systemPrompt?: string;
  temperature: number;
  maxOutputTokens?: number;
  requestId?: string;
}): ZaiChatCompletionRequest {
  const body: ZaiChatCompletionRequest = {
    model: args.model,
    messages: buildZaiMessages(args.prompt, args.systemPrompt),
    stream: false,
    do_sample: args.temperature > 0,
    temperature: normalizeTemperature(args.temperature),
    request_id: args.requestId ?? randomUUID(),
    user_id: DEFAULT_USER_ID,
    response_format: {
      type: "json_object",
    },
  };

  if (args.maxOutputTokens !== undefined) {
    body.max_tokens = args.maxOutputTokens;
  }

  return body;
}

export function buildZaiMessages(prompt: string, systemPrompt?: string): ZaiChatMessage[] {
  const systemContent = [systemPrompt?.trim(), ...FILE_MAP_OUTPUT_FORMAT_LINES]
    .filter((value): value is string => Boolean(value && value.trim() !== ""))
    .join("\n");

  return [
    {
      role: "system",
      content: systemContent,
    },
    {
      role: "user",
      content: prompt,
    },
  ];
}

export async function resolveZaiApiKey(args?: {
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = args?.env ?? process.env;
  const fromEnv = env.ZAI_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error("Z.AI API key not found. Set ZAI_API_KEY before running the benchmark.");
}

export function resolveZaiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ZAI_BASE_URL ?? env.ZAI_API_BASE_URL;
  return normalizeBaseUrl(value?.trim() || DEFAULT_ZAI_BASE_URL);
}

export function resolveZaiTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ZAI_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_ZAI_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ZAI_TIMEOUT_MS value: ${raw}`);
  }

  return parsed;
}

export function extractZaiRawText(response: ZaiChatCompletionResponse): string | undefined {
  return response.choices?.[0]?.message?.content?.trim() || undefined;
}

export function extractZaiFinishReason(response: ZaiChatCompletionResponse): string | undefined {
  return response.choices?.[0]?.finish_reason;
}

export function extractZaiUsage(response: ZaiChatCompletionResponse): ModelResponse["usage"] {
  const usage = response.usage;
  if (!usage) {
    return undefined;
  }

  if (
    usage.prompt_tokens === undefined &&
    usage.completion_tokens === undefined &&
    usage.total_tokens === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

async function invokeZaiChatCompletion(args: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  body: ZaiChatCompletionRequest;
}): Promise<{
  rawText: string;
  finishReason?: string;
  usage?: ModelResponse["usage"];
  requestId?: string;
  responseId?: string;
  responseModel?: string;
}> {
  let response: Response;

  try {
    response = await fetch(`${args.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Accept-Language": "en-US,en",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args.body),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Z.AI API request failed: ${message}`);
  }

  const rawResponseText = await response.text();
  const parsedResponse = parseZaiApiResponse(rawResponseText);

  if (!response.ok) {
    throw new Error(
      `Z.AI API returned ${response.status} ${response.statusText}.${formatZaiApiError(parsedResponse, rawResponseText)}`,
    );
  }

  const rawText = extractZaiRawText(parsedResponse);
  if (!rawText) {
    throw new Error(
      `Z.AI API returned no assistant content.${formatZaiEmptyContentDetails(parsedResponse)}`,
    );
  }

  return {
    rawText,
    finishReason: extractZaiFinishReason(parsedResponse),
    usage: extractZaiUsage(parsedResponse),
    requestId: parsedResponse.request_id,
    responseId: parsedResponse.id,
    responseModel: parsedResponse.model,
  };
}

function normalizeTemperature(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseZaiApiResponse(rawText: string): ZaiChatCompletionResponse {
  try {
    return JSON.parse(rawText) as ZaiChatCompletionResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Z.AI API returned invalid JSON: ${message}${formatResponseBody(rawText)}`);
  }
}

function formatZaiApiError(response: ZaiChatCompletionResponse, rawText: string): string {
  const parts: string[] = [];

  if (typeof response.error?.message === "string" && response.error.message.trim() !== "") {
    parts.push(response.error.message.trim());
  }

  if (typeof response.error?.code === "string" && response.error.code.trim() !== "") {
    parts.push(`code=${response.error.code.trim()}`);
  }

  const detail = parts.join(" ");
  if (detail) {
    return ` ${detail}`;
  }

  return formatResponseBody(rawText);
}

function formatZaiEmptyContentDetails(response: ZaiChatCompletionResponse): string {
  const finishReason = extractZaiFinishReason(response);
  if (finishReason) {
    return ` finish_reason=${finishReason}.`;
  }

  return "";
}

function formatResponseBody(rawText: string): string {
  const value = rawText.trim();
  if (!value) {
    return "";
  }

  return ` body: ${value}`;
}
