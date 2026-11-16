import { afterEach, expect, it, vi } from "vitest";
import { execute, type Dependencies } from "../src/action.js";
import { parseInputs } from "../src/inputs.js";
import { initialRecord } from "../src/github.js";
import { ActionError } from "../src/model.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("delivers the secret only to buildx and suppresses leaked failure details", async () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  vi.stubEnv("RUNNER_NAME", "test-runner");
  const inputs = parseInputs((key) => ({ app: "reader", components: "- name: web", deploy: "false", "image-prefix": "ghcr.io/example/reader", secrets: "SENTRY_AUTH_TOKEN=sensitive-sentinel" })[key] ?? "");
  const record = initialRecord(inputs, { GITHUB_RUN_ID: "123", GITHUB_RUN_NUMBER: "1", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "example/reader", GITHUB_REPOSITORY_ID: "456", GITHUB_SHA: "a".repeat(40) }, new Date());
  const log = vi.fn();
  let buildSeen = false;
  const deps: Dependencies = {
    exec: async (_command, args, options) => {
      expect(args.join(" ")).not.toContain("sensitive-sentinel");
      if (options?.phase === "build") {
        buildSeen = true;
        expect(args).toContain("id=SENTRY_AUTH_TOKEN,env=APP_RELEASE_BUILD_SECRET_0");
        expect(options.env?.APP_RELEASE_BUILD_SECRET_0).toBe("sensitive-sentinel");
        expect(options.suppressFailureDetail).toBe(true);
        throw new ActionError("test_stop", "build", "Build stopped", "sensitive-sentinel");
      }
      expect(options?.env?.APP_RELEASE_BUILD_SECRET_0).toBeUndefined();
      return { stdout: "", stderr: "" };
    },
    fetch: async (url) => Response.json(String(url).includes("/jobs?") ? { jobs: [{ runner_name: "test-runner", status: "in_progress", started_at: "2026-01-01T00:00:00Z" }] } : String(url).includes("/commits/") ? { commit: { committer: { date: "2026-01-01T00:00:00Z" } } } : { created_at: "2026-01-01T00:00:00Z" }),
    now: () => new Date("2026-01-01T00:00:00Z"), sleep: vi.fn(), state: vi.fn(), log,
    installRegctl: async () => "regctl", existingTailscale: async () => false, prepareTailscale: async () => "unused",
  };
  await expect(execute(inputs, record, "repo-token", "/unused", deps)).rejects.toMatchObject({ code: "test_stop" });
  expect(buildSeen).toBe(true);
  expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-sentinel");
  expect(JSON.stringify(record)).not.toContain("sensitive-sentinel");
});
