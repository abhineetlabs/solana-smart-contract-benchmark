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

check("stores authority on initialize", (source) =>
  source.includes("counter.authority = ctx.accounts.authority.key()") ||
  source.includes("counter.authority = authority.key()"),
);

check("resets count on initialize", (source) =>
  source.includes("counter.count = 0"),
);

check("increments count", (source) =>
  /counter\.count\s*=\s*counter[\s\S]*checked_add\(1\)/m.test(source) ||
  source.includes("counter.count = counter.count + 1"),
);

check("updates authority", (source) =>
  source.includes("ctx.accounts.counter.authority = new_authority") ||
  source.includes("counter.authority = new_authority"),
);

check("declares unauthorized error", (source) =>
  source.includes("Unauthorized"),
);

const result = { passed, total, failures };
console.log(JSON.stringify(result));

if (failures.length > 0) {
  process.exit(1);
}
