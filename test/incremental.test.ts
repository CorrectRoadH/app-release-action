import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAction } from "../src/runner.js";
import type { Run } from "../src/process.js";

const names = ["app", "agent", "web"];
const prefix = "ghcr.io/example/reader";
const version = "2026.1.1-42.1";
const timestamp = "2026-01-01T00:00:00Z";
const baseline = { revision: "a".repeat(40), state: "b".repeat(64) };
const digest = `sha256:${"c".repeat(64)}`;
const manifest = { config: { digest, size: 1 }, layers: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  { scenario: "matching baseline", incremental: true },
  { scenario: "baseline changed during build", incremental: true, conflict: true },
  { scenario: "legacy deployer", legacy: true },
  { scenario: "malformed baseline state", state: "z".repeat(64) },
  { scenario: "different revision", base: "d".repeat(40) },
  { scenario: "missing base input", base: "" },
  { scenario: "missing changes input", changes: "" },
  { scenario: "empty changes", changes: "[]" },
  { scenario: "all components changed", changes: JSON.stringify(names) },
  { scenario: "build-only", buildOnly: true },
  { scenario: "matrix with a matching baseline", matrix: true, incremental: true },
  { scenario: "matrix falling back to every component", matrix: true, legacy: true },
])("builds, pushes and reports the expected components with $scenario", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "app-release-incremental-"));
  try {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    for (const [key, value] of Object.entries({
      RUNNER_TEMP: directory,
      RUNNER_NAME: "test-runner",
      GITHUB_REPOSITORY: "example/reader",
      GITHUB_REPOSITORY_ID: "456",
      GITHUB_ACTOR: "test-actor",
      GITHUB_SHA: "e".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_NUMBER: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_PATH: undefined,
      GITHUB_STEP_SUMMARY: undefined,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    })) vi.stubEnv(key, value);

    const inputs: Record<string, string> = {
      app: "reader",
      components: names.map((name) => `- name: ${name}\n  dockerfile: ${name}/Dockerfile`).join("\n"),
      "image-prefix": prefix,
      "github-token": "repository-token",
      "deployer-url": "http://deployer.example",
      "incremental-base": test.base ?? baseline.revision,
      "changed-components": test.changes ?? '["app"]',
      deploy: test.buildOnly ? "false" : "true",
      network: "direct",
    };
    const built: string[] = [];
    const pushed: string[] = [];
    const requests: unknown[] = [];
    const outputs = new Map<string, string>();
    const failed = vi.fn();
    const exec: Run = async (_command, args) => {
      if (args[1] === "build") {
        const file = args[args.indexOf("--file") + 1];
        built.push(file);
        const name = file.split("/")[0];
        expect(args[args.indexOf("--cache-from") + 1]).toBe(`type=gha,scope=reader-${name}`);
        expect(args[args.indexOf("--cache-to") + 1]).toBe(`type=gha,mode=max,scope=reader-${name}`);
        const output = args[args.indexOf("--output") + 1];
        const oci = output.slice("type=oci,dest=".length, -",tar=false".length);
        await mkdir(oci);
        await writeFile(join(oci, "index.json"), JSON.stringify(manifest));
      }
      if (args[3] === "copy") pushed.push(args[5]);
      return { stdout: args[3] === "digest" ? digest : "", stderr: "" };
    };
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "oidc.example") return Response.json({ value: "deployer-token" });
      if (url.host === "deployer.example") {
        requests.push(JSON.parse(String(init?.body)));
        if (url.pathname === "/v1/releases/check") {
          return Response.json({
            ok: true,
            components: Object.fromEntries(names.map((name) => [name, `${prefix}-${name}`])),
            baseline: test.legacy ? undefined : { ...baseline, state: test.state ?? baseline.state },
          });
        }
        if (test.conflict) {
          return Response.json({ code: "base_changed", phase: "request" }, { status: 409 });
        }
        return Response.json({ release_id: "reader-123-1", app: "reader", version, status: "healthy" });
      }
      if (url.host === "api.github.com") {
        if (url.pathname.includes("/commits/"))
          return Response.json({ commit: { committer: { date: timestamp } } });
        if (url.pathname.endsWith("/jobs"))
          return Response.json({ jobs: [{ runner_name: "test-runner", status: "in_progress", started_at: timestamp }] });
        return Response.json({ created_at: timestamp });
      }
      expect(url.host).toBe("ghcr.io");
      if (url.pathname === "/token") return Response.json({ token: "registry-token" });
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      return Response.json(manifest);
    };

    const artifact = vi.fn(async () => {});
    const invoke = (time = timestamp) => runAction({
      input: (key) => inputs[key] ?? "",
      output: (key, value) => { outputs.set(key, value); },
      state: vi.fn(), log: vi.fn(), failed,
      artifact,
    }, {
      exec,
      fetch: fetcher,
      now: () => new Date(time),
      installRegctl: async () => "regctl",
    });

    const updated = test.incremental ? ["app"] : names;
    if (test.matrix) {
      inputs.stage = "plan";
      await invoke();
      expect(outputs.get("status")).toBe("planned");
      expect(built).toEqual([]);
      expect(requests).toEqual([{ app: "reader", components: names }]);
      expect(artifact).not.toHaveBeenCalled();
      expect(JSON.parse(outputs.get("build-components")!)).toEqual(updated);
      inputs.plan = outputs.get("plan")!;
      inputs.stage = "build";
      const results: Record<string, unknown>[] = [];
      for (const [i, component] of updated.entries()) {
        inputs["build-component"] = component;
        await invoke(`2026-01-02T00:00:0${i}Z`);
        expect(outputs.get("status")).toBe("built");
        results.unshift(JSON.parse(outputs.get("build-result")!));
      }
      expect(requests).toHaveLength(1);
      expect(artifact).not.toHaveBeenCalled();

      inputs.stage = "finalize";
      const invalidResults = [results.slice(1), [{ ...results[0], version: "2026.1.2-42.2" }, ...results.slice(1)]];
      if (results.length > 1) invalidResults.push(results.map(() => results[0]));
      for (const invalid of invalidResults) {
        inputs["build-results"] = JSON.stringify(invalid);
        await invoke("2026-01-02T00:00:09Z");
        expect(failed).toHaveBeenCalledWith(expect.stringContaining("invalid_stage_input"));
        expect(requests).toHaveLength(1);
        failed.mockClear();
      }
      inputs["build-results"] = JSON.stringify(results);
      vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
      await invoke("2026-01-02T00:00:09Z");
      expect(failed).toHaveBeenCalledWith(expect.stringContaining("Re-run all jobs."));
      expect(requests).toHaveLength(1);
      failed.mockClear();
      vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
      artifact.mockClear();
      await invoke("2026-01-02T00:00:09Z");
      expect(outputs.get("version")).toBe(version);
      expect(artifact).toHaveBeenCalledOnce();
    } else {
      await invoke();
    }

    const status = test.conflict ? "failed" : test.buildOnly ? "built" : "healthy";
    expect(outputs.get("status")).toBe(status);
    if (test.conflict) expect(failed).toHaveBeenCalledWith(expect.stringContaining("base_changed"));
    else expect(failed).not.toHaveBeenCalled();
    expect(built).toEqual(updated.map((name) => `${name}/Dockerfile`));
    expect(pushed).toEqual(updated.map((name) => `${prefix}-${name}:${version}`));
    expect(JSON.parse(outputs.get("digests")!)).toEqual(
      Object.fromEntries(updated.map((name) => [name, digest])),
    );
    const record = JSON.parse(await readFile(outputs.get("record")!, "utf8"));
    expect(record.components.map((component: { name: string }) => component.name)).toEqual(updated);

    if (test.buildOnly) {
      expect(requests).toEqual([]);
    } else {
      expect(requests).toEqual([
        { app: "reader", components: names },
        {
          app: "reader", version,
          components: Object.fromEntries(updated.map((name) => [name, { image: `${prefix}-${name}`, digest }])),
          ...(test.incremental ? { incremental: { ...baseline, retain: ["agent", "web"] } } : {}),
          build: expect.objectContaining({ components: record.components }),
        },
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
