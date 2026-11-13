import { describe, it, expect } from "vitest";
import { durations, summary, failure } from "../src/model.js";
import { cacheStats, classifyLayers } from "../src/oci.js";
import { verify } from "../src/tools.js";
const digest = (n: string) => `sha256:${n.repeat(64)}`;
describe("measurements", () => {
  it("deduplicates completed rawjson vertices and handles partial events and diagnostics", () => {
    const raw = [
      "non-json",
      { vertexes: [{ digest: "a", cached: false }] },
      { vertexes: [{ digest: "a", completed: "now", cached: true }] },
      { vertexes: [{ digest: "a", completed: "now", cached: true }] },
      {
        vertexes: [
          { digest: "b", completed: "now" },
          { digest: "bad", completed: "now", error: "failed" },
          { digest: "unfinished" },
        ],
      },
      { statuses: [{ id: "download", completed: "now" }] },
    ]
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");
    expect(cacheStats(raw)).toEqual({
      cache_hit_steps: 1,
      cache_miss_steps: 1,
    });
  });
  it("counts reuse and only sums missing compressed layer bytes", async () => {
    const exists: string[] = [];
    const result = await classifyLayers(
      [
        { digest: digest("a"), size: 100 },
        { digest: digest("b"), size: 25 },
        { digest: digest("c"), size: 50 },
      ],
      async (d) => {
        exists.push(d);
        return d === digest("a");
      },
    );
    expect(exists).toEqual([digest("a"), digest("b"), digest("c")]);
    expect(result).toEqual({
      layers: 3,
      layers_reused: 1,
      image_bytes: 175,
      pushed_bytes: 75,
    });
  });
  it("does not double-count repeated missing blobs", async () => {
    expect(
      (
        await classifyLayers(
          [
            { digest: digest("a"), size: 25 },
            { digest: digest("a"), size: 25 },
          ],
          async () => false,
        )
      ).pushed_bytes,
    ).toBe(25);
  });
  it("propagates HEAD errors rather than reporting every layer as new", async () => {
    await expect(
      classifyLayers([{ digest: digest("a"), size: 1 }], async () => {
        throw Error("401");
      }),
    ).rejects.toThrow("401");
  });
  it("calculates fractional durations and preserves missing stages", () => {
    const t = {
      run_created: "2026-01-01T00:00:00Z",
      job_started: "2026-01-01T00:00:06Z",
      build_started: "2026-01-01T00:00:08Z",
      build_finished: "2026-01-01T00:00:09.400Z",
      push_started: "2026-01-01T00:00:10Z",
      push_finished: "2026-01-01T00:00:12Z",
      deploy_requested: "2026-01-01T00:00:13Z",
      written_back: "2026-01-01T00:00:15Z",
      synced: "2026-01-01T00:00:20Z",
      healthy: "2026-01-01T00:00:30Z",
      committed: "2025-12-31T23:59:30Z",
    };
    expect(durations(t)).toEqual({
      queue: 6,
      build: 1.4,
      push: 2,
      write_back: 2,
      sync: 5,
      rollout: 10,
      lead_time: 60,
    });
    expect(durations({})).toEqual({
      queue: null,
      build: null,
      push: null,
      write_back: null,
      sync: null,
      rollout: null,
      lead_time: null,
    });
    expect(
      durations({
        build_started: t.build_finished,
        build_finished: t.build_started,
      }).build,
    ).toBeNull();
  });
  it("never propagates arbitrary exception messages", () =>
    expect(failure(Error("secret-token"), "deploy").message).not.toContain(
      "secret-token",
    ));
  it("verifies pinned download checksums", () => {
    expect(() =>
      verify(
        Buffer.from("hello"),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      ),
    ).not.toThrow();
    expect(() =>
      verify(
        Buffer.from("tampered"),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      ),
    ).toThrow("SHA-256");
  });
});
// Covered with real release records in action.test.ts; keep the formatter export checked here too.
it("exports the summary formatter", () =>
  expect(typeof summary).toBe("function"));
