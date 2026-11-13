import * as core from "@actions/core";
import { rm } from "node:fs/promises";
import { run } from "./process.js";
import { cleanupTailscale } from "./tailscale.js";
async function post(): Promise<void> {
  let failed = false;
  const tailscale = core.getState("tailscale");
  if (tailscale)
    try {
      await cleanupTailscale(tailscale, run);
    } catch {
      failed = true;
    }
  const builder = core.getState("builder");
  if (builder)
    try {
      await run("docker", ["buildx", "rm", "--force", builder], {
        phase: "builder_cleanup",
        timeoutMs: 60000,
      });
    } catch {
      failed = true;
    }
  const work = core.getState("work");
  if (work && !failed) await rm(work, { recursive: true, force: true });
  if (failed)
    core.setFailed(
      "cleanup_failed during post: Could not release action resources",
    );
}
post().catch(() =>
  core.setFailed(
    "cleanup_failed during post: Could not release action resources",
  ),
);
