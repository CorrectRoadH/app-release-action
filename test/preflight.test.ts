import { afterEach, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, type Dependencies } from "../src/action.js";
import { parseInputs } from "../src/inputs.js";
import { initialRecord } from "../src/github.js";
import { ActionError } from "../src/model.js";

const baseline = { revision: "b".repeat(40), state: "c".repeat(64) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(["direct", "tailscale"] as const)(
  "%s connects and validates before any build tooling, and stops on failure",
  async (network) => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://oidc.example/token");
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "oidc-request-credential");
    const directory = await mkdtemp(join(tmpdir(), "action-preflight-"));
    try {
      for (const accepted of [false, true]) {
        const inputs = parseInputs((key) => ({
          app: "reader", components: "- name: api\n- name: web", network,
          "image-prefix": "ghcr.io/correctroadh/reader",
          "deployer-url": "http://deployer.example",
          "tailscale-client-id": "client", "tailscale-audience": "audience",
          "incremental-base": baseline.revision, "changed-components": '["web"]',
        })[key] || "");
        const record = initialRecord(inputs, {
          GITHUB_RUN_ID: "123", GITHUB_RUN_NUMBER: "42", GITHUB_RUN_ATTEMPT: "1",
          GITHUB_REPOSITORY: "example/reader", GITHUB_REPOSITORY_ID: "456",
          GITHUB_SHA: "a".repeat(40),
        }, new Date("2026-01-01T00:00:00Z"));
        const events: string[] = [];
        const deps: Dependencies = {
          exec: vi.fn(async (_command, _args, options) => {
            events.push(options?.phase ?? "exec");
            return { stdout: "", stderr: "" };
          }),
          fetch: vi.fn(async (url, init) => {
            if (String(url).startsWith("https://oidc.example/")) {
              events.push("oidc");
              return Response.json({ value: "deployer-oidc-token" });
            }
            events.push("check");
            expect(String(url)).toBe("http://deployer.example/v1/releases/check");
            expect(JSON.parse(String(init?.body))).toEqual({ app: "reader", components: ["api", "web"] });
            return accepted
              ? Response.json({ ok: true, components: { api: "ghcr.io/correctroadh/reader-api", web: "ghcr.io/correctroadh/reader-web" }, baseline })
              : Response.json({ code: "components_mismatch", phase: "request", missing: ["agent"], unexpected: [] }, { status: 400 });
          }),
          now: () => new Date("2026-01-01T00:00:00Z"),
          sleep: vi.fn(), state: vi.fn(), log: vi.fn(),
          existingTailscale: async () => false,
          prepareTailscale: vi.fn(async () => { events.push("prepare-tailscale"); return "unused"; }),
          installRegctl: vi.fn(async () => {
            events.push("install-regctl");
            throw new ActionError("stop_after_preflight", "setup", "Test boundary reached");
          }),
        };
        await expect(execute(inputs, record, "repository-token", directory, deps))
          .rejects.toMatchObject({ code: accepted ? "stop_after_preflight" : "components_mismatch" });
        expect(events).toEqual([
          ...(network === "tailscale" ? ["prepare-tailscale", "tailscale"] : []),
          "oidc", "check", ...(accepted ? ["install-regctl"] : []),
        ]);
        expect(record.components).toEqual([]);
        expect(record.timeline.build_started).toBeNull();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("build-only execution skips network setup and preflight", async () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  const inputs = parseInputs((key) => ({
    app: "reader", components: "- name: app", deploy: "false",
    "image-prefix": "ghcr.io/correctroadh/reader",
  })[key] || "");
  const record = initialRecord(inputs, {
    GITHUB_RUN_ID: "123", GITHUB_RUN_NUMBER: "42", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: "example/reader", GITHUB_REPOSITORY_ID: "456", GITHUB_SHA: "a".repeat(40),
  }, new Date());
  const fetcher = vi.fn();
  const prepare = vi.fn();
  await expect(execute(inputs, record, "repository-token", "unused", {
    fetch: fetcher, prepareTailscale: prepare,
    installRegctl: async () => { throw new ActionError("build_only", "setup", "Reached build setup"); },
  } as unknown as Dependencies)).rejects.toMatchObject({ code: "build_only" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
