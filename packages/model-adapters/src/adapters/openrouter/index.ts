import { FILE_MAP_OUTPUT_FORMAT_LINES, tryParseFileMapOutputFromText } from "../../../../shared/src/index.js";
import type { BenchmarkReasoningEffort, ModelAdapter, ModelRequest, ModelResponse } from "../../types.js";

const OPENROUTER_PREFIX = "openrouter/";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.2";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_USER_ID = "solana-smart-contract-benchmark";
const KNOWN_OPENROUTER_MODELS = [
  "openrouter/default",
  `openrouter/${DEFAULT_OPENROUTER_MODEL}`,
] as const;

type OpenRouterReasoningEffort = Exclude<BenchmarkReasoningEffort, "default">;

interface OpenRouterChatMessage {
  role: "system" | "user";
  content: string;
}

interface OpenRouterReasoningConfig {
  effort: OpenRouterReasoningEffort;
  exclude: boolean;
}

interface OpenRouterProviderPreferences {
  require_parameters: boolean;
}

interface OpenRouterChatCompletionRequest {
  model: string;
  messages: OpenRouterChatMessage[];
  stream: false;
  temperature: number;
  max_completion_tokens?: number;
  response_format: {
    type: "json_object";
  };
  reasoning?: OpenRouterReasoningConfig;
  metadata?: Record<string, string>;
  provider: OpenRouterProviderPreferences;
  user: string;
}

interface OpenRouterMessageContentPart {
  type?: string;
  text?: string;
  content?: string;
}

interface OpenRouterChatCompletionResponse {
  id?: string;
  model?: string;
  provider?: string | { name?: string; id?: string };
  choices?: Array<{
    index?: number;
    finish_reason?: string;
    native_finish_reason?: string;
    message?: {
      role?: string;
      content?: string | OpenRouterMessageContentPart[];
      reasoning?: string;
      refusal?: string | null;
      tool_calls?: unknown[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  error?: {
    message?: string;
    code?: string | number;
    metadata?: unknown;
  };
}

export class OpenRouterModelAdapter implements ModelAdapter {
  readonly id = "openrouter";

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (!request.modelId.startsWith(OPENROUTER_PREFIX)) {
      throw new Error(`Unsupported OpenRouter model id: ${request.modelId}`);
    }

    const apiKey = await resolveOpenRouterApiKey();
    const baseUrl = resolveOpenRouterBaseUrl();
    const timeoutMs = resolveOpenRouterTimeoutMs();
    const forwardedModel = resolveOpenRouterModelId(request.modelId);
    const startedAt = Date.now();

    const completion = await invokeOpenRouterChatCompletion({
      apiKey,
      baseUrl,
      timeoutMs,
      headers: resolveOpenRouterHeaders(),
      body: buildOpenRouterRequestBody({
        model: forwardedModel,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        reasoningEffort: request.reasoningEffort,
        metadata: buildOpenRouterMetadata(request),
      }),
    });

    return {
      rawText: completion.rawText,
      parsedOutput: tryParseFileMapOutputFromText(completion.rawText),
      latencyMs: Date.now() - startedAt,
      finishReason: completion.finishReason ?? "stop",
      reasoningEffort: request.reasoningEffort ?? "default",
      providerReasoningEffort: resolveOpenRouterProviderReasoningEffort(request.reasoningEffort),
      usage: completion.usage,
      providerMetadata: {
        provider: "openrouter",
        baseUrl,
        forwardedModel,
        responseModel: completion.responseModel,
        requestId: completion.requestId,
        responseId: completion.responseId,
        routingProvider: completion.routingProvider,
        nativeFinishReason: completion.nativeFinishReason,
      },
    };
  }
}

export function listOpenRouterModels(): string[] {
  return [...KNOWN_OPENROUTER_MODELS];
}

export function resolveOpenRouterModelId(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const suffix = modelId.slice(OPENROUTER_PREFIX.length).trim();
  if (!suffix || suffix === "default") {
    return env.OPENROUTER_DEFAULT_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  }

  return suffix;
}

export function buildOpenRouterRequestBody(args: {
  model: string;
  prompt: string;
  systemPrompt?: string;
  temperature: number;
  maxOutputTokens?: number;
  reasoningEffort?: BenchmarkReasoningEffort;
  metadata?: Record<string, string>;
  userId?: string;
}): OpenRouterChatCompletionRequest {
  const body: OpenRouterChatCompletionRequest = {
    model: args.model,
    messages: buildOpenRouterMessages(args.prompt, args.systemPrompt),
    stream: false,
    temperature: normalizeTemperature(args.temperature),
    response_format: {
      type: "json_object",
    },
    provider: {
      require_parameters: true,
    },
    user: args.userId ?? DEFAULT_USER_ID,
  };

  if (args.maxOutputTokens !== undefined) {
    body.max_completion_tokens = args.maxOutputTokens;
  }

  const reasoning = resolveOpenRouterReasoning(args.reasoningEffort);
  if (reasoning) {
    body.reasoning = reasoning;
  }

  if (args.metadata && Object.keys(args.metadata).length > 0) {
    body.metadata = args.metadata;
  }

  return body;
}

export function buildOpenRouterMessages(prompt: string, systemPrompt?: string): OpenRouterChatMessage[] {
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

export function buildOpenRouterMetadata(request: Pick<ModelRequest, "attemptIndex" | "metadata" | "mode">): Record<string, string> {
  const metadata: Record<string, string> = {
    benchmark: "solana-smart-contract-benchmark",
    mode: request.mode,
    attemptIndex: String(request.attemptIndex),
  };

  const taskId = request.metadata.taskId;
  if (typeof taskId === "string" && taskId.trim() !== "") {
    metadata.taskId = taskId;
  }

  const track = request.metadata.track;
  if (typeof track === "string" && track.trim() !== "") {
    metadata.track = track;
  }

  return metadata;
}

export async function resolveOpenRouterApiKey(args?: {
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = args?.env ?? process.env;
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error("OpenRouter API key not found. Set OPENROUTER_API_KEY before running the benchmark.");
}

export function resolveOpenRouterBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.OPENROUTER_BASE_URL ?? env.OPENROUTER_API_BASE_URL;
  return normalizeBaseUrl(value?.trim() || DEFAULT_OPENROUTER_BASE_URL);
}

export function resolveOpenRouterTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENROUTER_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_OPENROUTER_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid OPENROUTER_TIMEOUT_MS value: ${raw}`);
  }

  return parsed;
}

export function resolveOpenRouterHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {};

  const referer = env.OPENROUTER_HTTP_REFERER?.trim() || env.OPENROUTER_APP_URL?.trim();
  if (referer) {
    headers["HTTP-Referer"] = referer;
  }

  const title = env.OPENROUTER_TITLE?.trim()
    || env.OPENROUTER_X_TITLE?.trim()
    || env.OPENROUTER_APP_TITLE?.trim();
  if (title) {
    headers["X-OpenRouter-Title"] = title;
  }

  return headers;
}

export function extractOpenRouterRawText(response: OpenRouterChatCompletionResponse): string | undefined {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    const value = content.trim();
    return value || undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const combined = content
    .flatMap((part) => {
      if (typeof part?.text === "string") {
        return [part.text];
      }

      if (typeof part?.content === "string") {
        return [part.content];
      }

      return [];
    })
    .join("")
    .trim();

  return combined || undefined;
}

export function extractOpenRouterFinishReason(response: OpenRouterChatCompletionResponse): string | undefined {
  return response.choices?.[0]?.finish_reason;
}

export function extractOpenRouterNativeFinishReason(
  response: OpenRouterChatCompletionResponse,
): string | undefined {
  return response.choices?.[0]?.native_finish_reason;
}

export function extractOpenRouterUsage(response: OpenRouterChatCompletionResponse): ModelResponse["usage"] {
  const usage = response.usage;
  if (!usage) {
    return undefined;
  }

  const promptTokens = usage.prompt_tokens ?? usage.input_tokens;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens;
  const totalTokens =
    usage.total_tokens
    ?? (promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined);
  const estimatedCostUsd = usage.cost;

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    estimatedCostUsd === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCostUsd,
  };
}

function resolveOpenRouterReasoning(
  effort?: BenchmarkReasoningEffort,
): OpenRouterReasoningConfig | undefined {
  if (!effort || effort === "default") {
    return undefined;
  }

  return {
    effort,
    exclude: true,
  };
}

function resolveOpenRouterProviderReasoningEffort(
  effort?: BenchmarkReasoningEffort,
): string {
  return effort ?? "default";
}

async function invokeOpenRouterChatCompletion(args: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  headers: Record<string, string>;
  body: OpenRouterChatCompletionRequest;
}): Promise<{
  rawText: string;
  finishReason?: string;
  nativeFinishReason?: string;
  usage?: ModelResponse["usage"];
  requestId?: string;
  responseId?: string;
  responseModel?: string;
  routingProvider?: string;
}> {
  let response: Response;

  try {
    response = await fetch(`${args.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        ...args.headers,
      },
      body: JSON.stringify(args.body),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenRouter API request failed: ${message}`);
  }

  const rawResponseText = await response.text();
  const parsedResponse = parseOpenRouterApiResponse(rawResponseText);

  if (!response.ok) {
    throw new Error(
      `OpenRouter API returned ${response.status} ${response.statusText}.${formatOpenRouterApiError(parsedResponse, rawResponseText)}`,
    );
  }

  const rawText = extractOpenRouterRawText(parsedResponse);
  if (!rawText) {
    throw new Error(
      `OpenRouter API returned no assistant content.${formatOpenRouterEmptyContentDetails(parsedResponse)}`,
    );
  }

  return {
    rawText,
    finishReason: extractOpenRouterFinishReason(parsedResponse),
    nativeFinishReason: extractOpenRouterNativeFinishReason(parsedResponse),
    usage: extractOpenRouterUsage(parsedResponse),
    requestId: response.headers.get("x-request-id") ?? undefined,
    responseId: parsedResponse.id,
    responseModel: parsedResponse.model,
    routingProvider: extractOpenRouterRoutingProvider(parsedResponse),
  };
}

function normalizeTemperature(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 2) {
    return 2;
  }

  return value;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseOpenRouterApiResponse(rawText: string): OpenRouterChatCompletionResponse {
  try {
    return JSON.parse(rawText) as OpenRouterChatCompletionResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenRouter API returned invalid JSON: ${message}${formatResponseBody(rawText)}`);
  }
}

function extractOpenRouterRoutingProvider(response: OpenRouterChatCompletionResponse): string | undefined {
  const provider = response.provider;
  if (typeof provider === "string" && provider.trim() !== "") {
    return provider.trim();
  }

  if (provider && typeof provider === "object") {
    const name = provider.name?.trim();
    if (name) {
      return name;
    }

    const id = provider.id?.trim();
    if (id) {
      return id;
    }
  }

  return undefined;
}

function formatOpenRouterApiError(response: OpenRouterChatCompletionResponse, rawText: string): string {
  const parts: string[] = [];

  if (typeof response.error?.message === "string" && response.error.message.trim() !== "") {
    parts.push(response.error.message.trim());
  }

  if (response.error?.code !== undefined) {
    const code = String(response.error.code).trim();
    if (code) {
      parts.push(`code=${code}`);
    }
  }

  const detail = parts.join(" ");
  if (detail) {
    return ` ${detail}`;
  }

  return formatResponseBody(rawText);
}

function formatOpenRouterEmptyContentDetails(response: OpenRouterChatCompletionResponse): string {
  const details: string[] = [];
  const finishReason = extractOpenRouterFinishReason(response);
  if (finishReason) {
    details.push(`finish_reason=${finishReason}`);
  }

  const nativeFinishReason = extractOpenRouterNativeFinishReason(response);
  if (nativeFinishReason) {
    details.push(`native_finish_reason=${nativeFinishReason}`);
  }

  const refusal = response.choices?.[0]?.message?.refusal?.trim();
  if (refusal) {
    details.push(`refusal=${refusal}`);
  }

  if (details.length === 0) {
    return "";
  }

  return ` ${details.join(" ")}.`;
}

function formatResponseBody(rawText: string): string {
  const value = rawText.trim();
  if (!value) {
    return "";
  }

  return ` body: ${value}`;
}
