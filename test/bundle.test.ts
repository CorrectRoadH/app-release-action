import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
it("runs the committed JavaScript entrypoints and suppresses actual artifact SDK diagnostics", async () => {
  await mkdir(".test-temp", { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".test-temp", "bundle-"));
  try {
    const env = {
      ...process.env,
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: "",
      GITHUB_STATE: "",
      GITHUB_STEP_SUMMARY: join(directory, "summary"),
      INPUT_APP: "",
      INPUT_COMPONENTS: "",
      INPUT_DEPLOY: "true",
      "INPUT_GITHUB-TOKEN": "repository-token-sentinel",
      ACTIONS_RESULTS_URL: "",
      ACTIONS_RUNTIME_TOKEN: "artifact-token-sentinel",
      RUNNER_DEBUG: "1",
      ACTIONS_STEP_DEBUG: "true",
    };
    const result = spawnSync(process.execPath, ["dist/index.cjs"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    const logs = result.stdout + result.stderr;
    expect(logs).toContain("invalid_input during inputs");
    expect(logs).not.toContain("artifact-token-sentinel");
    expect(logs).not.toContain("repository-token-sentinel");
    expect(logs).not.toContain("Artifact upload failed with error");
    const record = JSON.parse(
      await readFile(join(directory, "app-release", "record.json"), "utf8"),
    );
    expect(record.result.error.code).toBe("invalid_input");
    const post = spawnSync(process.execPath, ["dist/post.cjs"], {
      env: { ...env, STATE_work: "", STATE_tailscale: "", STATE_builder: "" },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(post.status).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
