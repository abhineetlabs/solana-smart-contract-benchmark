import { readFile } from "node:fs/promises";
import path from "node:path";

const target = path.join(process.cwd(), "programs", "counter_authority", "src", "lib.rs");
const content = await readFile(target, "utf8");

const failures = [];

if (content.includes("todo!(") || content.includes("TODO") || content.includes("unimplemented!")) {
  failures.push("starter placeholders are still present");
}

if (!content.includes("pub fn initialize")) {
  failures.push("missing initialize instruction");
}

if (!content.includes("pub fn increment")) {
  failures.push("missing increment instruction");
}

if (!content.includes("pub fn set_authority")) {
  failures.push("missing set_authority instruction");
}

if (!content.includes("CounterAccount")) {
  failures.push("missing CounterAccount state");
}

if (failures.length > 0) {
  console.error("Build check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Build check passed.");
