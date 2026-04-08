import assert from "node:assert/strict";
import test from "node:test";

import {
  computeCapabilityRetryDelayMs,
  isRateLimitModelInvokeError,
  parseRetryAfterMs,
} from "./run.js";

test("detects rate limit model invoke errors from provider messages", () => {
  assert.equal(
    isRateLimitModelInvokeError("Z.AI API returned 429 Too Many Requests. Rate limit reached for requests code=1302"),
    true,
  );
  assert.equal(isRateLimitModelInvokeError("Z.AI API request failed: fetch failed"), false);
});

test("uses explicit retry_after_ms hints when present", () => {
  assert.equal(parseRetryAfterMs("Z.AI API returned 429 Too Many Requests. retry_after_ms=30000"), 30000);
  assert.equal(
    computeCapabilityRetryDelayMs(
      "Z.AI API returned 429 Too Many Requests. retry_after_ms=30000",
      1,
      0,
    ),
    30000,
  );
});

test("rate limit retries back off aggressively", () => {
  assert.equal(
    computeCapabilityRetryDelayMs(
      "Z.AI API returned 429 Too Many Requests. Rate limit reached for requests code=1302",
      1,
      0,
    ),
    10000,
  );
  assert.equal(
    computeCapabilityRetryDelayMs(
      "Z.AI API returned 429 Too Many Requests. Rate limit reached for requests code=1302",
      2,
      0,
    ),
    20000,
  );
});

test("generic model invoke failures still wait briefly before retrying", () => {
  assert.equal(computeCapabilityRetryDelayMs("Z.AI API request failed: fetch failed", 1, 0), 2000);
});
