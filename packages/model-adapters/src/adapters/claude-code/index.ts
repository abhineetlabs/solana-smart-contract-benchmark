import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseBenchmarkJsonFromText } from "../../../../shared/src/index.js";
import type {
  BenchmarkReasoningEffort,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
} from "../../types.js";

const CLAUDE_CODE_PREFIX = "claude-code/";
const KNOWN_CLAUDE_CODE_MODELS = ["claude-code/default", "claude-code/opus", "claude-code/sonnet"] as const;
const FILE_MAP_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    files: {
      type: "object",
      additionalProperties: {
        type: "string",
      },
    },
  },
  required: ["files"],
  additionalProperties: false,
});

interface ClaudeCodeCliEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  result?: string;
  stop_reason?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  structured_output?: {
    files?: Record<string, string>;
  };
}

export class ClaudeCodeModelAdapter implements ModelAdapter {
  readonly id = "claude-code";

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (!request.modelId.startsWith(CLAUDE_CODE_PREFIX)) {
      throw new Error(`Unsupported Claude Code model id: ${request.modelId}`);
    }

    const invocationDir = await mkdtemp(path.join(tmpdir(), "claude-code-benchmark-"));
    const startedAt = Date.now();
    const providerReasoningEffort = resolveClaudeCodeEffort(request.reasoningEffort);

    try {
      const cliResult = await invokeClaudeCode({
        model: resolveCliModelId(request.modelId),
        prompt: request.prompt,
        cwd: invocationDir,
        reasoningEffort: providerReasoningEffort,
      });

      const parsedOutput = extractStructuredOutput(cliResult);
      const rawText = JSON.stringify(parsedOutput, null, 2);
      const inputTokens = cliResult.usage?.input_tokens;
      const outputTokens = cliResult.usage?.output_tokens;

      return {
        rawText,
        parsedOutput,
        latencyMs: cliResult.duration_ms ?? Date.now() - startedAt,
        finishReason: cliResult.stop_reason ?? "stop",
        reasoningEffort: request.reasoningEffort ?? "default",
        providerReasoningEffort: providerReasoningEffort ?? "default",
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens:
            inputTokens !== undefined || outputTokens !== undefined
              ? (inputTokens ?? 0) + (outputTokens ?? 0)
              : undefined,
          estimatedCostUsd: cliResult.total_cost_usd,
        },
        providerMetadata: {
          provider: "claude-code",
          sessionId: cliResult.session_id,
          modelUsage: cliResult.modelUsage,
        },
      };
    } finally {
      await rm(invocationDir, { recursive: true, force: true });
    }
  }
}

export function listClaudeCodeModels(): string[] {
  return [...KNOWN_CLAUDE_CODE_MODELS];
}

function resolveCliModelId(modelId: string): string | undefined {
  const suffix = modelId.slice(CLAUDE_CODE_PREFIX.length).trim();
  if (!suffix || suffix === "default") {
    return undefined;
  }

  return suffix;
}

async function invokeClaudeCode(args: {
  model?: string;
  prompt: string;
  cwd: string;
  reasoningEffort?: "low" | "medium" | "high" | "max";
}): Promise<ClaudeCodeCliEnvelope> {
  const cliBinary = process.env.CLAUDE_BIN ?? "claude";
  const cliArgs = [
    "-p",
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    FILE_MAP_JSON_SCHEMA,
  ];

  if (args.model) {
    cliArgs.push("--model", args.model);
  }

  if (args.reasoningEffort) {
    cliArgs.push("--effort", args.reasoningEffort);
  }

  const { stdout, stderr } = await runCliCommand({
    command: cliBinary,
    args: cliArgs,
    cwd: args.cwd,
    stdin: args.prompt,
  });

  const output = extractLastNonEmptyLine(stdout);
  if (!output) {
    throw new Error(`Claude Code returned no JSON output.${formatStderr(stderr)}`);
  }

  let parsed: ClaudeCodeCliEnvelope;
  try {
    parsed = parseBenchmarkJsonFromText(output) as ClaudeCodeCliEnvelope;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude Code returned invalid JSON: ${message}${formatStderr(stderr)}`);
  }

  if (parsed.is_error) {
    throw new Error(`Claude Code returned an error result.${formatStderr(stderr)}`);
  }

  return parsed;
}

function resolveClaudeCodeEffort(
  reasoningEffort: BenchmarkReasoningEffort | undefined,
): "low" | "medium" | "high" | "max" | undefined {
  switch (reasoningEffort) {
    case undefined:
    case "default":
      return undefined;
    case "low":
    case "medium":
    case "high":
      return reasoningEffort;
    case "xhigh":
      return "max";
  }
}

async function runCliCommand(args: {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
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
      reject(new Error(`Failed to launch Claude Code CLI: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `Claude Code CLI exited with code ${code}.${formatStderr(stderr)}${formatStdout(stdout)}`,
        ),
      );
    });

    child.stdin.end(args.stdin);
  });
}

function extractStructuredOutput(result: ClaudeCodeCliEnvelope): { files: Record<string, string> } {
  const candidate = result.structured_output;
  if (!candidate || typeof candidate !== "object" || !candidate.files || typeof candidate.files !== "object") {
    throw new Error("Claude Code did not return structured_output.files.");
  }

  const files: Record<string, string> = {};
  for (const [relativePath, content] of Object.entries(candidate.files)) {
    if (typeof content !== "string") {
      throw new Error(`Claude Code returned a non-string file body for "${relativePath}".`);
    }

    files[relativePath] = content;
  }

  return { files };
}

function extractLastNonEmptyLine(value: string): string | undefined {
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1);
}

function formatStderr(stderr: string): string {
  const value = stderr.trim();
  return value ? ` stderr: ${value}` : "";
}

function formatStdout(stdout: string): string {
  const value = stdout.trim();
  return value ? ` stdout: ${value}` : "";
}
