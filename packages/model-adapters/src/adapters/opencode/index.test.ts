import assert from "node:assert/strict";
import test from "node:test";

import { extractLastText } from "./index.js";

test("extractLastText supports legacy single text events", () => {
  const text = extractLastText([
    {
      type: "text",
      part: {
        text: '{"files":{"src/lib.rs":"fn main() {}"}}',
      },
    },
  ]);

  assert.equal(text, '{"files":{"src/lib.rs":"fn main() {}"}}');
});

test("extractLastText reconstructs streamed text-delta output", () => {
  const text = extractLastText([
    {
      type: "step_start",
      part: {
        type: "step-start",
      },
    },
    {
      type: "text-start",
      part: {
        type: "text-start",
      },
    },
    {
      type: "text-delta",
      part: {
        type: "text-delta",
        text: '{"files":',
      },
    },
    {
      type: "text-delta",
      part: {
        type: "text-delta",
        delta: '{"src/lib.rs":"fn main() {}"}}',
      },
    },
    {
      type: "text-end",
      part: {
        type: "text-end",
      },
    },
  ]);

  assert.equal(text, '{"files":{\"src/lib.rs\":\"fn main() {}\"}}');
});

test("extractLastText also handles text fragments emitted via part.type", () => {
  const text = extractLastText([
    {
      part: {
        type: "text-delta",
        content: "hello",
      },
    },
    {
      part: {
        type: "text-delta",
        content: " world",
      },
    },
  ]);

  assert.equal(text, "hello world");
});
