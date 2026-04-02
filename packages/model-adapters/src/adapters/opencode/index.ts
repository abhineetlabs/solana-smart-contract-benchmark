import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelAdapter, ModelRequest, ModelResponse } from "../../types.js";

const OPENCODE_PREFIX = "opencode/";
const KNOWN_OPENCODE_MODELS = ["opencode/default"] as const;

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
    "Return only valid JSON.",
    'The JSON must have the exact shape {"files":{"relative/path":"full file contents"}}.',
    "Do not wrap the JSON in markdown fences.",
    "Do not include explanations before or after the JSON.",
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
  parsedOutput: { files: Record<string, string> };
  finishReason?: string;
  forwardedModel?: string;
  sessionId?: string;
  usage?: ModelResponse["usage"];
}> {
  const cliBinary = process.env.OPENCODE_BIN ?? "opencode";
  const cliArgs = ["run", "--format", "json"];

  if (args.model) {
    cliArgs.push("--model", args.model);
  }

  cliArgs.push(args.prompt);

  const { stdout, stderr } = await runCliCommand({
    command: cliBinary,
    args: cliArgs,
    cwd: args.cwd,
  });

  const events = parseOpenCodeEvents(stdout);
  const rawText = extractLastText(events);
  if (!rawText) {
    throw new Error(`OpenCode returned no text output.${formatStderr(stderr)}`);
  }

  return {
    rawText,
    parsedOutput: extractStructuredOutput(rawText),
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
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      env: process.env,
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

function extractLastText(events: OpenCodeEvent[]): string | undefined {
  return [...events]
    .reverse()
    .find((event) => event.type === "text" && typeof event.part?.text === "string")
    ?.part?.text
    ?.trim();
}

function extractFinishReason(events: OpenCodeEvent[]): string | undefined {
  return [...events]
    .reverse()
    .find((event) => event.type === "step_finish" && typeof event.part?.reason === "string")
    ?.part?.reason;
}

function extractSessionId(events: OpenCodeEvent[]): string | undefined {
  return events.find((event) => typeof event.sessionID === "string")?.sessionID;
}

function extractUsage(events: OpenCodeEvent[]): ModelResponse["usage"] {
  const finishEvent = [...events]
    .reverse()
    .find((event) => event.type === "step_finish" && event.part?.tokens);

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenCode returned invalid JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || !("files" in parsed)) {
    throw new Error("OpenCode did not return a files map.");
  }

  const candidate = (parsed as { files?: unknown }).files;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("OpenCode returned a malformed files map.");
  }

  const files: Record<string, string> = {};
  for (const [relativePath, content] of Object.entries(candidate)) {
    if (typeof content !== "string") {
      throw new Error(`OpenCode returned a non-string file body for "${relativePath}".`);
    }

    files[relativePath] = content;
  }

  return { files };
}

function formatStderr(stderr: string): string {
  const value = stderr.trim();
  return value ? ` stderr: ${value}` : "";
}

function formatStdout(stdout: string): string {
  const value = stdout.trim();
  return value ? ` stdout: ${value}` : "";
}
