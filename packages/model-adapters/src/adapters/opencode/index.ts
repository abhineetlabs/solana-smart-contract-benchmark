import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FILE_MAP_OUTPUT_FORMAT_LINES, tryParseFileMapOutputFromText } from "../../../../shared/src/index.js";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../../types.js";

const OPENCODE_PREFIX = "opencode/";
const KNOWN_OPENCODE_MODELS = ["opencode/default"] as const;
const OPENCODE_BENCHMARK_PERMISSION = JSON.stringify({
  read: "deny",
  edit: "deny",
  bash: "deny",
  glob: "deny",
  grep: "deny",
  list: "deny",
  task: "deny",
  skill: "deny",
  lsp: "deny",
  todoread: "deny",
  todowrite: "deny",
  webfetch: "deny",
  websearch: "deny",
  codesearch: "deny",
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
});

interface OpenCodeEvent {
  type?: string;
  timestamp?: number;
  sessionID?: string;
  part?: {
    id?: string;
    messageID?: string;
    sessionID?: string;
    type?: string;
    text?: string;
    delta?: string;
    content?: string;
    reason?: string;
    tokens?: {
      total?: number;
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: {
        write?: number;
        read?: number;
      };
    };
    cost?: number;
  };
}

export class OpenCodeModelAdapter implements ModelAdapter {
  readonly id = "opencode";

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (!request.modelId.startsWith(OPENCODE_PREFIX)) {
      throw new Error(`Unsupported OpenCode model id: ${request.modelId}`);
    }

    if (request.reasoningEffort && request.reasoningEffort !== "default") {
      throw new Error(
        `OpenCode adapter does not support configurable reasoning effort. Remove --reasoning-effort or use a supported adapter.`,
      );
    }

    const invocationDir = await mkdtemp(path.join(tmpdir(), "opencode-benchmark-"));
    const startedAt = Date.now();

    try {
      const cliResult = await invokeOpenCode({
        model: resolveCliModelId(request.modelId),
        prompt: buildOpenCodePrompt(request.prompt),
        cwd: invocationDir,
      });

      return {
        rawText: cliResult.rawText,
        parsedOutput: cliResult.parsedOutput,
        latencyMs: Date.now() - startedAt,
        finishReason: cliResult.finishReason ?? "stop",
        reasoningEffort: request.reasoningEffort ?? "default",
        providerReasoningEffort: "default",
        usage: cliResult.usage,
        providerMetadata: {
          provider: "opencode",
          sessionId: cliResult.sessionId,
          forwardedModel: cliResult.forwardedModel,
        },
      };
    } finally {
      await rm(invocationDir, { recursive: true, force: true });
    }
  }
}

export function listOpenCodeModels(): string[] {
  return [...KNOWN_OPENCODE_MODELS];
}

function resolveCliModelId(modelId: string): string | undefined {
  const suffix = modelId.slice(OPENCODE_PREFIX.length).trim();
  if (!suffix || suffix === "default") {
    return undefined;
  }

  return suffix;
}

function buildOpenCodePrompt(prompt: string): string {
  return [
    ...FILE_MAP_OUTPUT_FORMAT_LINES,
    "",
    prompt,
  ].join("\n");
}

async function invokeOpenCode(args: {
  model?: string;
  prompt: string;
  cwd: string;
}): Promise<{
  rawText: string;
  parsedOutput?: { files: Record<string, string> };
  finishReason?: string;
  forwardedModel?: string;
  sessionId?: string;
  usage?: ModelResponse["usage"];
}> {
  const cliBinary = process.env.OPENCODE_BIN ?? "opencode";
  const cliArgs = ["run", "--pure", "--format", "json"];

  if (args.model) {
    cliArgs.push("--model", args.model);
  }

  cliArgs.push(args.prompt);

  const { stdout, stderr } = await runCliCommand({
    command: cliBinary,
    args: cliArgs,
    cwd: args.cwd,
    env: {
      ...process.env,
      OPENCODE_PERMISSION: OPENCODE_BENCHMARK_PERMISSION,
    },
  });

  const events = parseOpenCodeEvents(stdout);
  const rawText = extractLastText(events);
  if (!rawText) {
    throw new Error(
      `OpenCode returned no text output.${formatStderr(stderr)}${formatStdoutTail(stdout)}`,
    );
  }

  return {
    rawText,
    parsedOutput: tryExtractStructuredOutput(rawText),
    finishReason: extractFinishReason(events),
    forwardedModel: args.model,
    sessionId: extractSessionId(events),
    usage: extractUsage(events),
  };
}

async function runCliCommand(args: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      env: args.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to launch OpenCode CLI: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(`OpenCode CLI exited with code ${code}.${formatStderr(stderr)}${formatStdout(stdout)}`),
      );
    });
  });
}

function parseOpenCodeEvents(stdout: string): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed) as OpenCodeEvent);
    } catch {
      // Ignore any non-JSON chatter in the event stream.
    }
  }

  return events;
}

export function extractLastText(events: OpenCodeEvent[]): string | undefined {
  const legacyText = [...events]
    .reverse()
    .find((event) => normalizeEventType(event) === "text")
    ?.part?.text
    ?.trim();
  if (legacyText) {
    return legacyText;
  }

  const chunks: string[] = [];

  for (const event of events) {
    const eventType = normalizeEventType(event);
    if (!eventType || !isTextEventType(eventType)) {
      continue;
    }

    const fragment = extractTextFragment(event.part);
    if (fragment) {
      chunks.push(fragment);
    }
  }

  const combined = chunks.join("").trim();
  return combined || undefined;
}

function extractFinishReason(events: OpenCodeEvent[]): string | undefined {
  return [...events]
    .reverse()
    .find((event) => normalizeEventType(event) === "step_finish" && typeof event.part?.reason === "string")
    ?.part?.reason;
}

function extractSessionId(events: OpenCodeEvent[]): string | undefined {
  return events.find((event) => typeof event.sessionID === "string")?.sessionID;
}

function extractUsage(events: OpenCodeEvent[]): ModelResponse["usage"] {
  const finishEvent = [...events]
    .reverse()
    .find((event) => normalizeEventType(event) === "step_finish" && event.part?.tokens);

  const tokens = finishEvent?.part?.tokens;
  const inputTokens = tokens?.input;
  const outputTokens = tokens?.output;
  const totalTokens = tokens?.total;
  const estimatedCostUsd = finishEvent?.part?.cost;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    estimatedCostUsd === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    estimatedCostUsd,
  };
}

function extractStructuredOutput(rawText: string): { files: Record<string, string> } {
  const parsed = tryParseFileMapOutputFromText(rawText);
  if (!parsed) {
    throw new Error("OpenCode returned invalid file-map JSON.");
  }

  return parsed;
}

function tryExtractStructuredOutput(rawText: string): { files: Record<string, string> } | undefined {
  return tryParseFileMapOutputFromText(rawText);
}

function formatStderr(stderr: string): string {
  const value = stderr.trim();
  return value ? ` stderr: ${value}` : "";
}

function formatStdout(stdout: string): string {
  const value = stdout.trim();
  return value ? ` stdout: ${value}` : "";
}

function formatStdoutTail(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }

  return ` stdout_tail: ${lines.slice(-5).join(" | ")}`;
}

function normalizeEventType(event: OpenCodeEvent): string | undefined {
  const eventType = event.type?.trim();
  if (eventType === "finish-step") {
    return "step_finish";
  }
  if (eventType) {
    return eventType;
  }

  const partType = event.part?.type?.trim();
  if (!partType) {
    return undefined;
  }

  if (partType === "finish-step") {
    return "step_finish";
  }

  return partType;
}

function isTextEventType(eventType: string): boolean {
  return eventType === "text" || eventType === "text-start" || eventType === "text-delta" || eventType === "text-end";
}

function extractTextFragment(part: OpenCodeEvent["part"]): string | undefined {
  const candidates = [part?.text, part?.delta, part?.content];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}
