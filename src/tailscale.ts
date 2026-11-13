import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ActionError } from "./model.js";
import { type Inputs } from "./inputs.js";
import { type Run } from "./process.js";
export function tailscaleEnv(
  directory: string,
  inputs?: Inputs,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: directory,
    XDG_CACHE_HOME: directory,
    RUNNER_DEBUG: "0",
    ACTIONS_STEP_DEBUG: "false",
    INPUT_AUTHKEY: "",
    "INPUT_OAUTH-SECRET": "",
    "INPUT_OAUTH-CLIENT-ID": inputs?.tailscaleClientId || "",
    INPUT_AUDIENCE: inputs?.tailscaleAudience || "",
    INPUT_TAGS: "tag:ci",
    INPUT_VERSION: "1.104.5",
    INPUT_ARGS: "",
    "INPUT_TAILSCALED-ARGS": "",
    INPUT_HOSTNAME: `app-release-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    INPUT_TIMEOUT: "2m",
    INPUT_RETRY: "3",
    "INPUT_USE-CACHE": "false",
    INPUT_STATEDIR: "",
    INPUT_PING: "",
    INPUT_SHA256SUM:
      process.arch === "arm64"
        ? "e900b0e6e25023a1e504b2c237ce2a32ea0535e006f8c1a1097a490886493b6c"
        : "720cbbccbfc03d8b55df72afc19e5a72e31b0f65934700aa6fa38074d4ad7bf7",
    "INPUT_LOG-MODE": "quiet",
  };
}
export async function existingTailscale(): Promise<boolean> {
  try {
    await access("/var/run/tailscale/tailscaled.sock");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function connectTailscale(
  directory: string,
  inputs: Inputs,
  exec: Run,
  exists = existingTailscale,
): Promise<void> {
  // Official action owns a new daemon; never replace a runner's existing Tailnet connection.
  if (!(await exists())) {
    await writeFile(join(directory, "started"), "true");
    await exec(process.execPath, [join(directory, "dist/index.js")], {
      env: tailscaleEnv(directory, inputs),
      timeoutMs: 600000,
      phase: "tailscale",
    });
    return;
  }
  throw new ActionError(
    "tailscale_in_use",
    "tailscale",
    "A fresh runner without an existing Tailscale daemon is required",
  );
}
export async function cleanupTailscale(
  directory: string,
  exec: Run,
): Promise<void> {
  try {
    await access(join(directory, "started"));
  } catch {
    return;
  }
  try {
    await access(join(directory, "cleaned"));
    return;
  } catch {
    /* Cleanup is still required. */
  }
  await exec(process.execPath, [join(directory, "dist/logout/index.js")], {
    env: tailscaleEnv(directory),
    timeoutMs: 60000,
    phase: "tailscale_cleanup",
  });
  // The official post hook reports cleanup errors as warnings. Detect a surviving owned daemon.
  try {
    const pid = Number(
      await readFile(join(directory, "tailscaled.pid"), "utf8"),
    );
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          await writeFile(join(directory, "cleaned"), "true");
          return;
        }
        throw new ActionError(
          "cleanup_failed",
          "tailscale_cleanup",
          "Could not verify Tailscale daemon termination",
        );
      }
      throw new ActionError(
        "cleanup_failed",
        "tailscale_cleanup",
        "Tailscale daemon is still running",
      );
    }
  } catch (error) {
    if (error instanceof ActionError) throw error;
  }
  await writeFile(join(directory, "cleaned"), "true");
}
