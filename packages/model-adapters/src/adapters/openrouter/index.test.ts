import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenRouterMessages,
  buildOpenRouterMetadata,
  buildOpenRouterRequestBody,
  extractOpenRouterRawText,
  extractOpenRouterUsage,
  resolveOpenRouterApiKey,
  resolveOpenRouterBaseUrl,
  resolveOpenRouterHeaders,
  resolveOpenRouterModelId,
  resolveOpenRouterProviderPreferences,
  resolveOpenRouterTimeoutMs,
} from "./index.js";

test("resolveOpenRouterModelId maps default to the repo default or an env override", () => {
  assert.equal(resolveOpenRouterModelId("openrouter/default", {}), "openai/gpt-5.2");
  assert.equal(
    resolveOpenRouterModelId("openrouter/default", { OPENROUTER_DEFAULT_MODEL: "anthropic/claude-sonnet-4" }),
    "anthropic/claude-sonnet-4",
  );
  assert.equal(resolveOpenRouterModelId("openrouter/openai/gpt-5.2"), "openai/gpt-5.2");
  assert.equal(resolveOpenRouterModelId("openrouter/qwen/qwen3-coder"), "qwen/qwen3-coder");
});

test("buildOpenRouterMessages prepends structured output instructions in the system message", () => {
  const messages = buildOpenRouterMessages("# Task", "You are careful.");

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /You are careful\./);
  assert.match(messages[0]?.content ?? "", /Return only a JSON object with exactly one top-level key/);
  assert.deepEqual(messages[1], {
    role: "user",
    content: "# Task",
  });
});

test("buildOpenRouterRequestBody enables JSON mode, provider parameter enforcement, and reasoning exclusion", () => {
  const body = buildOpenRouterRequestBody({
    model: "openai/gpt-5.2",
    prompt: "# Task",
    temperature: 0,
    maxOutputTokens: 4096,
    reasoningEffort: "high",
    metadata: {
      taskId: "counter_authority",
      track: "anchor",
    },
  });

  assert.equal(body.model, "openai/gpt-5.2");
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_completion_tokens, 4096);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.deepEqual(body.reasoning, { effort: "high", exclude: true });
  assert.deepEqual(body.metadata, {
    taskId: "counter_authority",
    track: "anchor",
  });
});

test("buildOpenRouterRequestBody can pin provider routing preferences", () => {
  const body = buildOpenRouterRequestBody({
    model: "z-ai/glm-5.1",
    prompt: "# Task",
    temperature: 0,
    providerPreferences: {
      require_parameters: true,
      only: ["fireworks"],
      allow_fallbacks: false,
    },
  });

  assert.deepEqual(body.provider, {
    require_parameters: true,
    only: ["fireworks"],
    allow_fallbacks: false,
  });
});

test("buildOpenRouterMetadata forwards only compact benchmark metadata", () => {
  const metadata = buildOpenRouterMetadata({
    attemptIndex: 2,
    mode: "offline",
    metadata: {
      taskId: "escrow_basic",
      track: "native",
      fixtureFilesJson: "{\"too\":\"large\"}",
    },
  });

  assert.deepEqual(metadata, {
    benchmark: "solana-smart-contract-benchmark",
    mode: "offline",
    attemptIndex: "2",
    taskId: "escrow_basic",
    track: "native",
  });
});

test("resolveOpenRouterApiKey requires an explicit environment variable", async () => {
  assert.equal(await resolveOpenRouterApiKey({ env: { OPENROUTER_API_KEY: "env-key" } }), "env-key");
  await assert.rejects(
    () => resolveOpenRouterApiKey({ env: {} }),
    /Set OPENROUTER_API_KEY before running the benchmark/,
  );
});

test("resolveOpenRouterBaseUrl, timeout, and app headers honor environment overrides", () => {
  assert.equal(resolveOpenRouterBaseUrl({}), "https://openrouter.ai/api/v1");
  assert.equal(
    resolveOpenRouterBaseUrl({ OPENROUTER_BASE_URL: "https://example.com/custom/" }),
    "https://example.com/custom",
  );
  assert.equal(
    resolveOpenRouterBaseUrl({ OPENROUTER_API_BASE_URL: "https://example.com/alt///" }),
    "https://example.com/alt",
  );
  assert.equal(resolveOpenRouterTimeoutMs({ OPENROUTER_TIMEOUT_MS: "1234" }), 1234);
  assert.deepEqual(
    resolveOpenRouterHeaders({
      OPENROUTER_HTTP_REFERER: "https://benchmark.example",
      OPENROUTER_TITLE: "Solana Benchmark",
    }),
    {
      "HTTP-Referer": "https://benchmark.example",
      "X-OpenRouter-Title": "Solana Benchmark",
    },
  );
});

test("resolveOpenRouterProviderPreferences parses pinning and routing env vars", () => {
  assert.deepEqual(resolveOpenRouterProviderPreferences({}), {
    require_parameters: true,
  });

  assert.deepEqual(
    resolveOpenRouterProviderPreferences({
      OPENROUTER_PROVIDER_ONLY: "fireworks",
      OPENROUTER_PROVIDER_ORDER: "fireworks,groq",
      OPENROUTER_PROVIDER_IGNORE: "together",
      OPENROUTER_ALLOW_FALLBACKS: "false",
    }),
    {
      require_parameters: true,
      only: ["fireworks"],
      order: ["fireworks", "groq"],
      ignore: ["together"],
      allow_fallbacks: false,
    },
  );

  assert.throws(
    () => resolveOpenRouterProviderPreferences({ OPENROUTER_ALLOW_FALLBACKS: "maybe" }),
    /Invalid OPENROUTER_ALLOW_FALLBACKS value/,
  );
});

test("extractOpenRouterRawText and usage parse successful responses", () => {
  const response = {
    choices: [
      {
        finish_reason: "stop",
        native_finish_reason: "stop",
        message: {
          content: [
            { type: "output_text", text: '{"files":' },
            { type: "output_text", text: '{"programs/counter_authority/src/lib.rs":"fn main() {}"}}' },
          ],
        },
      },
    ],
    usage: {
      input_tokens: 111,
      output_tokens: 222,
      total_tokens: 333,
      cost: 0.0123,
    },
  };

  assert.equal(
    extractOpenRouterRawText(response),
    '{"files":{"programs/counter_authority/src/lib.rs":"fn main() {}"}}',
  );
  assert.deepEqual(extractOpenRouterUsage(response), {
    promptTokens: 111,
    completionTokens: 222,
    totalTokens: 333,
    estimatedCostUsd: 0.0123,
  });
});
