import assert from "node:assert/strict";
import test from "node:test";

import {
  buildZaiMessages,
  buildZaiRequestBody,
  extractZaiRawText,
  extractZaiUsage,
  resolveZaiApiKey,
  resolveZaiBaseUrl,
  resolveZaiModelId,
  resolveZaiTimeoutMs,
} from "./index.js";

test("resolveZaiModelId maps default to glm-5.1", () => {
  assert.equal(resolveZaiModelId("zai/default"), "glm-5.1");
  assert.equal(resolveZaiModelId("zai/glm-5.1"), "glm-5.1");
  assert.equal(resolveZaiModelId("zai/glm-5"), "glm-5");
});

test("buildZaiMessages prepends structured output instructions in the system message", () => {
  const messages = buildZaiMessages("# Task", "You are careful.");

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /You are careful\./);
  assert.match(messages[0]?.content ?? "", /Return only a JSON object with exactly one top-level key/);
  assert.deepEqual(messages[1], {
    role: "user",
    content: "# Task",
  });
});

test("buildZaiRequestBody uses JSON mode and deterministic sampling at temperature 0", () => {
  const body = buildZaiRequestBody({
    model: "glm-5.1",
    prompt: "# Task",
    temperature: 0,
    maxOutputTokens: 2048,
    requestId: "req_123",
  });

  assert.equal(body.model, "glm-5.1");
  assert.equal(body.stream, false);
  assert.equal(body.do_sample, false);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.request_id, "req_123");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("resolveZaiApiKey requires an explicit environment variable", async () => {
  assert.equal(await resolveZaiApiKey({ env: { ZAI_API_KEY: "env-key" } }), "env-key");
  await assert.rejects(() => resolveZaiApiKey({ env: {} }), /Set ZAI_API_KEY before running the benchmark/);
});

test("resolveZaiBaseUrl and resolveZaiTimeoutMs honor environment overrides", () => {
  assert.equal(resolveZaiBaseUrl({}), "https://api.z.ai/api/paas/v4");
  assert.equal(resolveZaiBaseUrl({ ZAI_BASE_URL: "https://example.com/custom/" }), "https://example.com/custom");
  assert.equal(resolveZaiBaseUrl({ ZAI_API_BASE_URL: "https://example.com/alt///" }), "https://example.com/alt");
  assert.equal(resolveZaiTimeoutMs({ ZAI_TIMEOUT_MS: "1234" }), 1234);
});

test("extractZaiRawText and usage parse successful responses", () => {
  const response = {
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: '{"files":{"programs/counter_authority/src/lib.rs":"fn main() {}"}}',
        },
      },
    ],
    usage: {
      prompt_tokens: 111,
      completion_tokens: 222,
      total_tokens: 333,
    },
  };

  assert.equal(
    extractZaiRawText(response),
    '{"files":{"programs/counter_authority/src/lib.rs":"fn main() {}"}}',
  );
  assert.deepEqual(extractZaiUsage(response), {
    promptTokens: 111,
    completionTokens: 222,
    totalTokens: 333,
  });
});
