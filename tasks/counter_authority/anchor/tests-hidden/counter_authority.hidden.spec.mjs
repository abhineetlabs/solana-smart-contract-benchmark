import { readFile } from "node:fs/promises";
import path from "node:path";

const target = path.join(process.cwd(), "programs", "counter_authority", "src", "lib.rs");
const content = await readFile(target, "utf8");

let passed = 0;
let total = 0;
const failures = [];

function check(description, predicate) {
  total += 1;
  if (predicate(content)) {
    passed += 1;
    return;
  }

  failures.push(description);
}

function functionBody(name) {
  const nextFunctionPattern =
    name === "increment"
      ? /\n\s*pub fn set_authority/
      : /\n\}\n/;
  const startPattern = new RegExp(String.raw`pub fn ${name}\([^\)]*\) -> Result<\(\)> \{`);
  const startMatch = content.match(startPattern);
  if (!startMatch || startMatch.index === undefined) {
    return "";
  }

  const startIndex = startMatch.index + startMatch[0].length;
  const remainder = content.slice(startIndex);
  const nextBoundary = remainder.search(nextFunctionPattern);
  return nextBoundary >= 0 ? remainder.slice(0, nextBoundary) : remainder;
}

const incrementBody = functionBody("increment");
const setAuthorityBody = functionBody("set_authority");

check("increment requires authority guard", (source) =>
  incrementBody.includes("require_keys_eq!") ||
  incrementBody.includes("counter.authority"),
);

check("set_authority requires authority guard", (source) =>
  setAuthorityBody.includes("require_keys_eq!") ||
  setAuthorityBody.includes("counter.authority"),
);

check("increment uses checked arithmetic", (source) =>
  source.includes("checked_add(1)"),
);

const result = { passed, total, failures };
console.log(JSON.stringify(result));

if (failures.length > 0) {
  process.exit(1);
}
