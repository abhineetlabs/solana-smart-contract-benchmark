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

check("adversarial: unauthorized increment is rejected", (source) =>
  incrementBody.includes("require_keys_eq!") ||
  incrementBody.includes("CounterError::Unauthorized"),
);

check("adversarial: unauthorized authority transfer is rejected", (source) =>
  setAuthorityBody.includes("require_keys_eq!") ||
  setAuthorityBody.includes("CounterError::Unauthorized"),
);

check("adversarial: authority is stored in state", (source) =>
  /struct CounterAccount[\s\S]*authority: Pubkey/m.test(source),
);

const result = { passed, total, failures };
console.log(JSON.stringify(result));

if (failures.length > 0) {
  process.exit(1);
}
