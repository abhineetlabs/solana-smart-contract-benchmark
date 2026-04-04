import assert from "node:assert/strict";
import path from "node:path";

import { parseFileMapOutputFromText, pathExists, readTextFile } from "../packages/shared/src/index.js";

interface ParseCase {
  name: string;
  rawText: string;
  shouldPass: boolean;
}

const validFileMap = JSON.stringify(
  {
    files: {
      "programs/example/src/lib.rs": 'pub fn handler() {\n    msg!("ok");\n}\n',
    },
  },
  null,
  2,
);

const cases: ParseCase[] = [
  {
    name: "plain strict JSON",
    rawText: validFileMap,
    shouldPass: true,
  },
  {
    name: "exact backtick json fence",
    rawText: `\`\`\`json\n${validFileMap}\n\`\`\``,
    shouldPass: true,
  },
  {
    name: "exact tilde json fence",
    rawText: `~~~json\n${validFileMap}\n~~~`,
    shouldPass: true,
  },
  {
    name: "opening json fence without closing fence",
    rawText: `\`\`\`json\n${validFileMap}`,
    shouldPass: true,
  },
  {
    name: "extra top-level key is rejected",
    rawText: JSON.stringify({
      files: {
        "programs/example/src/lib.rs": "pub fn handler() {}\n",
      },
      note: "extra metadata",
    }),
    shouldPass: false,
  },
  {
    name: "prose before fenced json is rejected",
    rawText: `Here is the JSON you asked for:\n\n\`\`\`json\n${validFileMap}\n\`\`\``,
    shouldPass: false,
  },
  {
    name: "malformed json string is rejected",
    rawText: '{"files":{"programs/example/src/lib.rs":"unterminated}}',
    shouldPass: false,
  },
  {
    name: "non-string file body is rejected",
    rawText: JSON.stringify({
      files: {
        "programs/example/src/lib.rs": { body: "not allowed" },
      },
    }),
    shouldPass: false,
  },
];

for (const testCase of cases) {
  runCase(testCase);
}

const artifactChecks = [
  {
    name: "Gemini 3.1 Pro fenced anchor output",
    path: path.join(
      process.cwd(),
      "results",
      "2026-04-04T08-34-05-116Z_35b1ee8c",
      "attempts",
      "counter_authority_anchor_offline_attempt1",
      "raw-output.txt",
    ),
  },
  {
    name: "Gemini 3.1 Pro fenced native output",
    path: path.join(
      process.cwd(),
      "results",
      "2026-04-04T08-35-35-355Z_641c932d",
      "attempts",
      "counter_authority_native_offline_attempt1",
      "raw-output.txt",
    ),
  },
];

let artifactPassCount = 0;
for (const artifactCheck of artifactChecks) {
  if (!(await pathExists(artifactCheck.path))) {
    console.log(`- skipped artifact check: ${artifactCheck.name} (${artifactCheck.path})`);
    continue;
  }

  const rawText = await readTextFile(artifactCheck.path);
  const parsed = parseFileMapOutputFromText(rawText);
  assert.ok(Object.keys(parsed.files).length > 0, `${artifactCheck.name} parsed but returned no files.`);
  artifactPassCount += 1;
  console.log(`- passed artifact check: ${artifactCheck.name}`);
}

console.log(`Structured output checks passed: ${cases.length} synthetic, ${artifactPassCount} artifact.`);

function runCase(testCase: ParseCase): void {
  if (testCase.shouldPass) {
    const parsed = parseFileMapOutputFromText(testCase.rawText);
    assert.ok(Object.keys(parsed.files).length > 0, `${testCase.name} parsed but returned no files.`);
    console.log(`- passed: ${testCase.name}`);
    return;
  }

  assert.throws(
    () => parseFileMapOutputFromText(testCase.rawText),
    `${testCase.name} should have been rejected.`,
  );
  console.log(`- rejected as expected: ${testCase.name}`);
}
