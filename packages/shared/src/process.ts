import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export async function runCommand(
  command: string,
  cwd: string,
  envOverrides?: Record<string, string>,
): Promise<CommandResult> {
  const startedAt = new Date();

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        ...envOverrides,
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const endedAt = new Date();
      resolve({
        command,
        cwd,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        exitCode: code ?? 1,
        stdout,
        stderr,
        success: (code ?? 1) === 0,
      });
    });

    child.on("error", (error) => {
      const endedAt = new Date();
      resolve({
        command,
        cwd,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        exitCode: 1,
        stdout,
        stderr: `${stderr}${error.stack ?? error.message}\n`,
        success: false,
      });
    });
  });
}
