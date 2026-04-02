import { mkdir, readFile, writeFile, access, cp, lstat, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const SKIPPED_RUNTIME_ENTRIES = new Set([".anchor", ".tooling", "node_modules", "target"]);

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

export async function readJsonFile<T>(targetPath: string): Promise<T> {
  const content = await readFile(targetPath, "utf8");
  return JSON.parse(content) as T;
}

export async function writeJsonFile(targetPath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeTextFile(targetPath: string, value: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await writeFile(targetPath, value, "utf8");
}

export async function readTextFile(targetPath: string): Promise<string> {
  return readFile(targetPath, "utf8");
}

export async function copyDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await ensureDir(path.dirname(destinationDir));
  await cp(sourceDir, destinationDir, {
    recursive: true,
    filter: async (sourcePath) => shouldCopyPath(sourcePath),
  });
}

export async function listRelativeFiles(rootDir: string): Promise<string[]> {
  const output: string[] = [];
  await walk(rootDir, rootDir, output);
  return output.sort();
}

async function walk(rootDir: string, currentDir: string, output: string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIPPED_RUNTIME_ENTRIES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walk(rootDir, absolutePath, output);
      continue;
    }

    output.push(toPosixPath(path.relative(rootDir, absolutePath)));
  }
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function shouldCopyPath(sourcePath: string): Promise<boolean> {
  if (SKIPPED_RUNTIME_ENTRIES.has(path.basename(sourcePath))) {
    return false;
  }

  try {
    const stats = await lstat(sourcePath);
    return !stats.isSocket();
  } catch {
    return false;
  }
}
