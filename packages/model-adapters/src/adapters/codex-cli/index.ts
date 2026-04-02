import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelAdapter, ModelRequest, ModelResponse } from "../../types.js";

const CODEX_PREFIX = "codex/";
const CODEX_OSS_PREFIX = "codex-oss/";
const KNOWN_CODEX_MODELS = [
  "codex/default",
  "codex-oss/ollama/default",
  "codex-oss/lmstudio/default",
] as const;
const FILE_ENTRY_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: {
            type: "string",
          },
          content: {
            type: "string",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["files"],
  additionalProperties: false,
});

interface CodexCliEnvelope {
  rawText: string;
  parsedOutput: {
    files: Record<string, string>;
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  providerMetadata: Record<string, unknown>;
}

interface CodexCliEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

interface CodexInvocationConfig {
  localProvider?: "lmstudio" | "ollama";
  model?: string;
  oss: boolean;
}

interface CodexStructuredOutput {
  files?: Array<{
    path?: string;
    content?: string;
  }>;
}

export class CodexCliModelAdapter implements ModelAdapter {
  readonly id = "codex-cli";

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const config = resolveInvocationConfig(request.modelId);
    const invocationDir = await mkdtemp(path.join(tmpdir(), "codex-cli-benchmark-"));
    const startedAt = Date.now();

    try {
      const cliResult = await invokeCodexCli({
        ...config,
        cwd: invocationDir,
        prompt: request.prompt,
      });

      return {
        rawText: cliResult.rawText,
        parsedOutput: cliResult.parsedOutput,
        latencyMs: Date.now() - startedAt,
        finishReason: "stop",
        usage: cliResult.usage,
        providerMetadata: {
          provider: "codex-cli",
          ...cliResult.providerMetadata,
        },
      };
    } finally {
      await rm(invocationDir, { recursive: true, force: true });
    }
  }
}

export function listCodexCliModels(): string[] {
  return [...KNOWN_CODEX_MODELS];
}

function resolveInvocationConfig(modelId: string): CodexInvocationConfig {
  if (modelId.startsWith(CODEX_PREFIX)) {
    const suffix = modelId.slice(CODEX_PREFIX.length).trim();
    return {
      oss: false,
      model: suffix && suffix !== "default" ? suffix : undefined,
    };
  }

  if (modelId.startsWith(CODEX_OSS_PREFIX)) {
    const suffix = modelId.slice(CODEX_OSS_PREFIX.length).trim();
    const [provider, ...modelParts] = suffix.split("/").filter(Boolean);
    if (provider !== "ollama" && provider !== "lmstudio") {
      throw new Error(
        `Unsupported Codex OSS provider in model id "${modelId}". Expected codex-oss/ollama/<model> or codex-oss/lmstudio/<model>.`,
      );
    }

    const model = modelParts.join("/").trim();
    return {
      oss: true,
      localProvider: provider,
      model: model && model !== "default" ? model : undefined,
    };
  }

  throw new Error(`Unsupported Codex model id: ${modelId}`);
}

async function invokeCodexCli(args: CodexInvocationConfig & { cwd: string; prompt: string }): Promise<CodexCliEnvelope> {
  const cliBinary = process.env.CODEX_BIN ?? "codex";
  const schemaPath = path.join(args.cwd, "codex-output-schema.json");
  const outputPath = path.join(args.cwd, "codex-output.json");
  await writeFile(schemaPath, FILE_ENTRY_JSON_SCHEMA, "utf8");

  const cliArgs = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--json",
    "--output-schema",
    schemaPath,
    "-o",
    outputPath,
  ];

  if (args.oss) {
    cliArgs.push("--oss");
  }

  if (args.localProvider) {
    cliArgs.push("--local-provider", args.localProvider);
  }

  if (args.model) {
    cliArgs.push("--model", args.model);
  }

  cliArgs.push(args.prompt);

  const { stdout, stderr } = await runCliCommand({
    command: cliBinary,
    args: cliArgs,
    cwd: args.cwd,
  });

  const events = parseCodexEvents(stdout);
  const rawText = await readStructuredOutput({
    outputPath,
    events,
  });

  return {
    rawText,
    parsedOutput: extractStructuredOutput(rawText),
    usage: extractUsage(events),
    providerMetadata: {
      model: args.model ?? "default",
      localProvider: args.localProvider,
      oss: args.oss,
      stderr: stderr.trim() || undefined,
      threadId: extractThreadId(events),
    },
  };
}

async function readStructuredOutput(args: { outputPath: string; events: CodexCliEvent[] }): Promise<string> {
  try {
    const rawText = (await readFile(args.outputPath, "utf8")).trim();
    if (rawText) {
      return rawText;
    }
  } catch {
    // Fall back to the streamed item payload if the CLI did not write the output file.
  }

  const lastMessage = extractLastCompletedMessage(args.events);
  if (lastMessage) {
    return lastMessage;
  }

  throw new Error("Codex CLI returned no structured output.");
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
      reject(new Error(`Failed to launch Codex CLI: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(`Codex CLI exited with code ${code}.${formatStderr(stderr)}${formatStdout(stdout)}`),
      );
    });
  });
}

function parseCodexEvents(stdout: string): CodexCliEvent[] {
  const events: CodexCliEvent[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed) as CodexCliEvent);
    } catch {
      // Ignore any non-JSON chatter and keep the successful run output flowing.
    }
  }

  return events;
}

function extractStructuredOutput(rawText: string): { files: Record<string, string> } {
  let parsed: CodexStructuredOutput;
  try {
    parsed = JSON.parse(rawText) as CodexStructuredOutput;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex CLI returned invalid JSON: ${message}`);
  }

  if (!parsed.files || !Array.isArray(parsed.files)) {
    throw new Error("Codex CLI did not return a files array.");
  }

  const files: Record<string, string> = {};
  for (const entry of parsed.files) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Codex CLI returned a malformed file entry.");
    }

    if (!entry.path || typeof entry.path !== "string") {
      throw new Error("Codex CLI returned a file entry without a valid path.");
    }

    if (typeof entry.content !== "string") {
      throw new Error(`Codex CLI returned a non-string file body for "${entry.path}".`);
    }

    if (files[entry.path] !== undefined) {
      throw new Error(`Codex CLI returned duplicate content for "${entry.path}".`);
    }

    files[entry.path] = entry.content;
  }

  return { files };
}

function extractUsage(events: CodexCliEvent[]): ModelResponse["usage"] {
  const completedTurn = [...events].reverse().find((event) => event.type === "turn.completed" && event.usage);
  const inputTokens = completedTurn?.usage?.input_tokens;
  const cachedInputTokens = completedTurn?.usage?.cached_input_tokens;
  const outputTokens = completedTurn?.usage?.output_tokens;

  if (inputTokens === undefined && cachedInputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  const promptTokens =
    inputTokens !== undefined || cachedInputTokens !== undefined
      ? (inputTokens ?? 0) + (cachedInputTokens ?? 0)
      : undefined;

  return {
    promptTokens,
    completionTokens: outputTokens,
    totalTokens:
      promptTokens !== undefined || outputTokens !== undefined
        ? (promptTokens ?? 0) + (outputTokens ?? 0)
        : undefined,
  };
}

function extractThreadId(events: CodexCliEvent[]): string | undefined {
  return events.find((event) => event.type === "thread.started")?.thread_id;
}

function extractLastCompletedMessage(events: CodexCliEvent[]): string | undefined {
  return [...events]
    .reverse()
    .find((event) => event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text)
    ?.item?.text
    ?.trim();
}

function formatStderr(stderr: string): string {
  const value = stderr.trim();
  return value ? ` stderr: ${value}` : "";
}

function formatStdout(stdout: string): string {
  const value = stdout.trim();
  return value ? ` stdout: ${value}` : "";
}
