import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { Reporter, runAction as runActionType } from "../src/runner.js";

let bundleDirectory: string;
let reporter: Reporter;
let runAction: typeof runActionType;
beforeAll(async () => {
  bundleDirectory = await mkdtemp(join(tmpdir(), "artifact-runner-test-"));
  const entry = join(bundleDirectory, "runner.cjs");
  await build({ entryPoints: ["src/runner.ts"], outfile: entry, bundle: true, platform: "node", target: "node24", format: "cjs" });
  await copyFile("dist/artifact.cjs", join(bundleDirectory, "artifact.cjs"));
  ({ reporter, runAction } = createRequire(import.meta.url)(entry));
});
afterAll(async () => { await rm(bundleDirectory, { recursive: true, force: true }); });

afterEach(() => {
  vi.unstubAllEnvs();
});

async function fixture(message: string | null) {
  const directory = await mkdtemp(join(tmpdir(), "release-artifact-test-"));
  const recordPath = join(directory, "record.json");
  const summaryPath = join(directory, "summary.md");
  const record = { schema: "app-release/v1", result: { status: "healthy" } };
  await writeFile(recordPath, `${JSON.stringify(record)}\n`);
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests.push(`${req.method} ${req.url?.split("?")[0]}`);
    res.setHeader("Content-Type", "application/json");
    if (message) {
      res.statusCode = 403;
      res.end(JSON.stringify({ msg: message }));
    } else if (req.url?.endsWith("CreateArtifact")) {
      res.end(JSON.stringify({ ok: true, signed_upload_url: `${url}/account/container/record` }));
    } else if (req.url?.endsWith("FinalizeArtifact")) {
      res.end(JSON.stringify({ ok: true, artifact_id: "123" }));
    } else {
      res.statusCode = 201;
      res.setHeader("etag", '"test"');
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No test address");
  const url = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("ACTIONS_RUNTIME_TOKEN", `e30.${Buffer.from(JSON.stringify({ scp: "Actions.Results:test-run:test-job" })).toString("base64url")}.signature`);
  vi.stubEnv("ACTIONS_RESULTS_URL", url);
  vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
  vi.stubEnv("GITHUB_STEP_SUMMARY", summaryPath);
  return {
    directory, recordPath, summaryPath, record, requests,
    async close() {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("uploads through the real bundled SDK and finalizes the artifact", async () => {
  const f = await fixture(null);
  try {
    await reporter.artifact(f.recordPath, f.directory);
    expect(f.requests).toContain("POST /twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact");
    expect(f.requests.filter((request) => request.startsWith("PUT "))).toHaveLength(2);
  } finally { await f.close(); }
});

it("preserves the complete record and release status when GitHub reports full storage", async () => {
  const f = await fixture("Artifact storage quota has been hit. Unable to upload any new artifacts. credential-sentinel");
  try {
    await reporter.artifact(f.recordPath, f.directory);
    const text = await readFile(f.summaryPath, "utf8");
    expect(text).toContain(JSON.stringify(f.record));
    expect(text).not.toContain("credential-sentinel");
    expect(JSON.parse(await readFile(f.recordPath, "utf8"))).toEqual(f.record);
  } finally { await f.close(); }
});

it("still rejects other service failures without echoing service diagnostics", async () => {
  const f = await fixture("Access denied: credential-sentinel");
  try {
    await writeFile(`${f.recordPath}.quota-exceeded`, "stale marker");
    await expect(reporter.artifact(f.recordPath, f.directory)).rejects.toThrow("Command failed during artifact");
    await expect(readFile(f.summaryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
});

it("does not turn an existing release failure into success during quota fallback", async () => {
  const f = await fixture("Artifact storage quota has been hit");
  try {
    vi.stubEnv("RUNNER_TEMP", f.directory);
    const failed = vi.fn();
    await runAction({ ...reporter, input: () => "", failed, output: vi.fn(), state: vi.fn(), log: vi.fn() });
    expect(failed).toHaveBeenCalledWith(expect.stringContaining("invalid_input during inputs"));
    const record = JSON.parse(await readFile(join(f.directory, "app-release", "record.json"), "utf8"));
    expect(record.result.status).toBe("failed");
    expect(record.result.error.code).toBe("invalid_input");
    expect(await readFile(f.summaryPath, "utf8")).toContain('"invalid_input"');
  } finally { await f.close(); }
});

it("fails closed when quota exhaustion has no persistent summary fallback", async () => {
  const f = await fixture("Artifact storage quota has been hit");
  try {
    vi.stubEnv("GITHUB_STEP_SUMMARY", "");
    await expect(reporter.artifact(f.recordPath, f.directory)).rejects.toMatchObject({ code: "artifact_quota_exceeded" });
  } finally { await f.close(); }
});
