import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelAdapter, ModelRequest, ModelResponse } from "../../types.js";

const GEMINI_PREFIX = "gemini/";
const KNOWN_GEMINI_MODELS = ["gemini/default"] as const;

interface GeminiJsonOutput {
  response?: string;
  stats?: {
    models?: Record<
      string,
      {
        tokens?: {
          prompt?: number;
          candidates?: number;
          total?: number;
        };
      }
    >;
    tools?: {
      totalCalls?: number;
      byName?: Record<string, unknown>;
    };
  };
}

export class GeminiCliModelAdapter implements ModelAdapter {
  readonly id = "gemini-cli";

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (!request.modelId.startsWith(GEMINI_PREFIX)) {
      throw new Error(`Unsupported Gemini model id: ${request.modelId}`);
    }

    const invocationDir = await mkdtemp(path.join(tmpdir(), "gemini-cli-benchmark-"));
    const startedAt = Date.now();

    try {
      const cliResult = await invokeGeminiCli({
        cwd: invocationDir,
        model: resolveGeminiModelId(request.modelId),
        prompt: buildGeminiPrompt(request.prompt),
      });

      enforceOfflineToolPolicy(cliResult.output);

      return {
        rawText: cliResult.rawText,
        parsedOutput: extractStructuredOutput(cliResult.rawText),
        latencyMs: Date.now() - startedAt,
        finishReason: "stop",
        usage: extractUsage(cliResult.output),
        providerMetadata: {
          provider: "gemini-cli",
          forwardedModel: cliResult.forwardedModel,
          toolsUsed: extractToolNames(cliResult.output),
          stderr: cliResult.stderr || undefined,
        },
      };
    } finally {
      await rm(invocationDir, { recursive: true, force: true });
    }
  }
}

export function listGeminiCliModels(): string[] {
  return [...KNOWN_GEMINI_MODELS];
}

function resolveGeminiModelId(modelId: string): string | undefined {
  const suffix = modelId.slice(GEMINI_PREFIX.length).trim();
  if (!suffix || suffix === "default") {
    return undefined;
  }

  return suffix;
}

function buildGeminiPrompt(prompt: string): string {
  return [
    "Return only valid JSON.",
    'The JSON must have the exact shape {"files":{"relative/path":"full file contents"}}.',
    "Do not wrap the JSON in markdown fences.",
    "Do not include explanations before or after the JSON.",
    "Do not use any tools, shell commands, web search, file reads, or MCP servers.",
    "",
    prompt,
  ].join("\n");
}

async function invokeGeminiCli(args: {
  cwd: string;
  model?: string;
  prompt: string;
}): Promise<{
  output: GeminiJsonOutput;
  rawText: string;
  forwardedModel?: string;
  stderr: string;
}> {
  const cliBinary = process.env.GEMINI_BIN ?? "gemini";
  const cliArgs = ["-p", args.prompt, "--output-format", "json"];

  if (args.model) {
    cliArgs.push("--model", args.model);
  }

  const { stdout, stderr } = await runCliCommand({
    command: cliBinary,
    args: cliArgs,
    cwd: args.cwd,
  });

  const output = parseGeminiOutput(stdout);
  const rawText = output.response?.trim();
  if (!rawText) {
    throw new Error(`Gemini CLI returned no response text.${formatStderr(stderr)}`);
  }

  return {
    output,
    rawText,
    forwardedModel: args.model,
    stderr: stderr.trim(),
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
      reject(new Error(`Failed to launch Gemini CLI: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(`Gemini CLI exited with code ${code}.${formatStderr(stderr)}${formatStdout(stdout)}`),
      );
    });
  });
}

function parseGeminiOutput(stdout: string): GeminiJsonOutput {
  try {
    return JSON.parse(stdout) as GeminiJsonOutput;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Gemini CLI returned invalid JSON output: ${message}`);
  }
}

function extractStructuredOutput(rawText: string): { files: Record<string, string> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Gemini CLI returned invalid JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || !("files" in parsed)) {
    throw new Error("Gemini CLI did not return a files map.");
  }

  const candidate = (parsed as { files?: unknown }).files;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Gemini CLI returned a malformed files map.");
  }

  const files: Record<string, string> = {};
  for (const [relativePath, contents] of Object.entries(candidate)) {
    if (typeof contents !== "string") {
      throw new Error(`Gemini CLI returned non-string contents for "${relativePath}".`);
    }

    files[relativePath] = contents;
  }

  return { files };
}

function extractUsage(output: GeminiJsonOutput): ModelResponse["usage"] {
  const modelEntries = Object.values(output.stats?.models ?? {});
  if (modelEntries.length === 0) {
    return undefined;
  }

  const promptTokens = sumMetric(modelEntries, (entry) => entry.tokens?.prompt);
  const completionTokens = sumMetric(modelEntries, (entry) => entry.tokens?.candidates);
  const totalTokens = sumMetric(modelEntries, (entry) => entry.tokens?.total);

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function sumMetric<T>(items: T[], pick: (item: T) => number | undefined): number | undefined {
  let found = false;
  let total = 0;

  for (const item of items) {
    const value = pick(item);
    if (value === undefined) {
      continue;
    }

    found = true;
    total += value;
  }

  return found ? total : undefined;
}

function extractToolNames(output: GeminiJsonOutput): string[] {
  return Object.keys(output.stats?.tools?.byName ?? {}).sort();
}

function enforceOfflineToolPolicy(output: GeminiJsonOutput): void {
  const totalCalls = output.stats?.tools?.totalCalls ?? 0;
  if (totalCalls === 0) {
    return;
  }

  const names = extractToolNames(output);
  throw new Error(
    `Gemini CLI used ${totalCalls} tool call(s) during an offline benchmark run${names.length > 0 ? ` (${names.join(", ")})` : ""}.`,
  );
}

function formatStdout(stdout: string): string {
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? `\nstdout:\n${trimmed}` : "";
}

function formatStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0 ? `\nstderr:\n${trimmed}` : "";
}
