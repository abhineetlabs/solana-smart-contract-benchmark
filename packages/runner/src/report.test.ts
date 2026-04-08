import assert from "node:assert/strict";
import test from "node:test";

import { getInterTargetCooldownMs } from "./report.js";

test("adds an inter-target cooldown for Z.AI sweeps", () => {
  assert.equal(getInterTargetCooldownMs("zai/default"), 5000);
  assert.equal(getInterTargetCooldownMs("zai/glm-5.1"), 5000);
});

test("does not slow down non-Z.AI sweeps", () => {
  assert.equal(getInterTargetCooldownMs("codex/default"), 0);
  assert.equal(getInterTargetCooldownMs("openrouter/default"), 0);
});
