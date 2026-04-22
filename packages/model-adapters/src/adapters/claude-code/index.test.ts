import assert from "node:assert/strict";
import test from "node:test";

import { resolveClaudeCodeEffort } from "./index.js";

test("resolveClaudeCodeEffort keeps benchmark xhigh and max aligned with Claude Code", () => {
  assert.equal(resolveClaudeCodeEffort(undefined), undefined);
  assert.equal(resolveClaudeCodeEffort("default"), undefined);
  assert.equal(resolveClaudeCodeEffort("low"), "low");
  assert.equal(resolveClaudeCodeEffort("medium"), "medium");
  assert.equal(resolveClaudeCodeEffort("high"), "high");
  assert.equal(resolveClaudeCodeEffort("xhigh"), "xhigh");
  assert.equal(resolveClaudeCodeEffort("max"), "max");
});
