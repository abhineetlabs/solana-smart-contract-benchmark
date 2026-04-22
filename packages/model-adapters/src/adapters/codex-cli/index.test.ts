import assert from "node:assert/strict";
import test from "node:test";

import { resolveCodexReasoningEffort } from "./index.js";

test("resolveCodexReasoningEffort keeps shared effort levels and rejects max", () => {
  assert.equal(resolveCodexReasoningEffort(undefined), undefined);
  assert.equal(resolveCodexReasoningEffort("default"), undefined);
  assert.equal(resolveCodexReasoningEffort("low"), "low");
  assert.equal(resolveCodexReasoningEffort("medium"), "medium");
  assert.equal(resolveCodexReasoningEffort("high"), "high");
  assert.equal(resolveCodexReasoningEffort("xhigh"), "xhigh");
  assert.throws(
    () => resolveCodexReasoningEffort("max"),
    /does not support benchmark reasoning effort "max"/,
  );
});
