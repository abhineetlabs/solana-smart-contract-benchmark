export interface ParsedFileMapOutput {
  files: Record<string, string>;
}

export const FILE_MAP_OUTPUT_FORMAT_LINES = [
  'Return only a JSON object with exactly one top-level key: "files".',
  'The JSON must match exactly: {"files":{"relative/path":"full file contents"}}.',
  "Do not wrap the JSON in markdown fences.",
  "Do not include explanations before or after the JSON.",
  'Each file body must be a valid JSON string value. Escape newlines, quotes, and backslashes exactly as JSON requires.',
];

export function parseBenchmarkJsonFromText<T = unknown>(rawText: string): T {
  const candidates = buildBenchmarkJsonCandidates(rawText);
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Model output was not valid JSON.");
}

export function tryParseBenchmarkJsonFromText<T = unknown>(rawText: string): T | undefined {
  try {
    return parseBenchmarkJsonFromText<T>(rawText);
  } catch {
    return undefined;
  }
}

export function normalizeFileMapOutput(value: unknown): ParsedFileMapOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Model output must be a JSON object with exactly one top-level key: "files".');
  }

  const topLevelKeys = Object.keys(value);
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== "files") {
    throw new Error('Model output must contain exactly one top-level key: "files".');
  }

  const candidate = (value as { files?: unknown }).files;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error('Model output "files" value must be an object.');
  }

  const files: Record<string, string> = {};
  for (const [relativePath, contents] of Object.entries(candidate)) {
    if (typeof contents !== "string") {
      throw new Error(`Model output for ${relativePath} must be a string.`);
    }

    files[relativePath] = contents;
  }

  return { files };
}

export function parseFileMapOutputFromText(rawText: string): ParsedFileMapOutput {
  return normalizeFileMapOutput(parseBenchmarkJsonFromText(rawText));
}

export function tryParseFileMapOutputFromText(rawText: string): ParsedFileMapOutput | undefined {
  try {
    return parseFileMapOutputFromText(rawText);
  } catch {
    return undefined;
  }
}

function buildBenchmarkJsonCandidates(rawText: string): string[] {
  const trimmed = stripBom(rawText).trim();
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (value: string | undefined): void => {
    const candidate = value?.trim();
    if (!candidate || seen.has(candidate)) {
      return;
    }

    seen.add(candidate);
    candidates.push(candidate);
  };

  pushCandidate(trimmed);

  const exactBacktickFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  pushCandidate(exactBacktickFenceMatch?.[1]);

  const exactTildeFenceMatch = trimmed.match(/^~~~(?:json)?\s*([\s\S]*?)\s*~~~$/i);
  pushCandidate(exactTildeFenceMatch?.[1]);

  return candidates;
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}
