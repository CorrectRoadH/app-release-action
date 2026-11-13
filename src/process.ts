import { spawn } from "node:child_process";
import { ActionError } from "./model.js";
export interface ProcessResult {
  stdout: string;
  stderr: string;
}
export interface ProcessOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  phase?: string;
  input?: string;
}
export type Run = (
  command: string,
  args: string[],
  options?: ProcessOptions,
) => Promise<ProcessResult>;
export const run: Run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const phase = options.phase || "process";
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: "pipe",
      detached: true,
    });
    let stdout = "",
      stderr = "",
      settled = false;
    const removeSignalHandlers = () => {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    };
    const cancel = () => fail("cancelled");
    const fail = (code = "process_failed") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeSignalHandlers();
      // Kill the entire command group, including docker/CLI helpers, on timeout or overflow.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      reject(new ActionError(code, phase, `Command failed during ${phase}`));
    };
    const timer = setTimeout(() => fail(), options.timeoutMs ?? 1800000);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > 32 * 1024 * 1024) fail();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > 32 * 1024 * 1024) fail();
    });
    child.on("error", () => fail());
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return fail();
      settled = true;
      clearTimeout(timer);
      removeSignalHandlers();
      resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => {
      /* Exit status is the source of failure. */
    });
    child.stdin.end(options.input);
  });
