import { it, expect, vi } from "vitest";
import { deploy, preflight, errorCodes } from "../src/client.js";
import { initialRecord } from "../src/github.js";
import { parseInputs } from "../src/inputs.js";
const inputs = parseInputs(
  (k) =>
    ({
      app: "reader",
      components: "- name: app",
      deploy: "false",
      "image-prefix": "ghcr.io/example/reader",
    })[k] || "",
);
const makeRecord = () =>
  initialRecord(
    inputs,
    {
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_NUMBER: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY: "example/reader",
      GITHUB_REPOSITORY_ID: "456",
      GITHUB_SHA: "a".repeat(40),
    },
    new Date("2026-01-01T00:00:00Z"),
  );
const release = (status: string) => ({
  release_id: "reader-123-1",
  app: "reader",
  version: "2026.1.1-42.1",
  status,
  infra_commit: "b".repeat(40),
  timeline: { deploy_requested: "2026-01-01T00:00:01Z" },
  error: null,
});
function harness(responses: Response[]) {
  let now = 0;
  const tokens: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
  const token = vi.fn(async () => {
    const t = `private-token-${tokens.length}`;
    tokens.push(t);
    return t;
  });
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  return { fetch: fetcher, token, now: () => now, sleep };
}
it.each(["healthy", "noop"])(
  "accepts successful terminal %s",
  async (status) => {
    const deps = harness([Response.json(release(status))]);
    expect(
      (await deploy(makeRecord(), "http://example", 10000, deps, () => {}))
        .status,
    ).toBe(status);
  },
);
it.each(["superseded", "failed"])("fails terminal %s", async (status) => {
  const deps = harness([Response.json(release(status))]);
  await expect(
    deploy(makeRecord(), "http://example", 10000, deps, () => {}),
  ).rejects.toMatchObject({ code: status });
});
it.each(["queued", "accepted", "writing", "syncing", "rolling_out"])(
  "polls %s every five seconds with a fresh token",
  async (status) => {
    const deps = harness([
      Response.json(release(status), { status: 202 }),
      Response.json(release("healthy")),
    ]);
    await deploy(makeRecord(), "http://example", 15000, deps, () => {});
    expect(deps.sleep).toHaveBeenCalledWith(5000);
    expect(deps.token).toHaveBeenCalledTimes(2);
    expect(
      deps.fetch.mock.calls.map(
        (c) => (c[1]?.headers as Record<string, string>).Authorization,
      ),
    ).toEqual(["Bearer private-token-0", "Bearer private-token-1"]);
    expect(deps.fetch.mock.calls[1][0]).toBe(
      "http://example/v1/releases/reader-123-1",
    );
  },
);
it.each(errorCodes)(
  "handles HTTP error %s without leaking server-echoed secrets",
  async (code) => {
    const deps = harness([
      Response.json(
        { code, phase: "write_back", message: "private-token-0" },
        { status: ["superseded", "base_changed"].includes(code) ? 409 : 503 },
      ),
    ]);
    await expect(
      deploy(makeRecord(), "http://example", 10000, deps, () => {}),
    ).rejects.toMatchObject({ code, phase: "write_back" });
    try {
      await deploy(
        makeRecord(),
        "http://example",
        10000,
        harness([
          Response.json({ code, message: "private-token-0" }, { status: 400 }),
        ]),
        () => {},
      );
    } catch (error) {
      expect(String(error)).not.toContain("private-token-0");
    }
  },
);
it.each(["sync_timeout", "degraded", "write_conflict", "upstream_unavailable", "base_changed"])(
  "handles terminal error %s",
  async (code) => {
    const body = {
      ...release("failed"),
      error: { code, phase: "rollout", message: "private-token-0" },
    };
    await expect(
      deploy(
        makeRecord(),
        "http://example",
        10000,
        harness([Response.json(body)]),
        () => {},
      ),
    ).rejects.toMatchObject({ code, phase: "rollout" });
  },
);
it("fails timeout and never polls after the deadline", async () => {
  const deps = harness([Response.json(release("queued"))]);
  await expect(
    deploy(makeRecord(), "http://example", 3000, deps, () => {}),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(deps.fetch).toHaveBeenCalledTimes(1);
});
it("bounds hanging OIDC acquisition", async () => {
  await expect(
    deploy(
      makeRecord(),
      "http://example",
      10,
      { ...harness([]), token: () => new Promise(() => {}) },
      () => {},
    ),
  ).rejects.toMatchObject({ code: "timeout" });
});
it("sanitizes failed network errors", async () => {
  const deps = harness([]);
  deps.fetch.mockRejectedValue(Error("private-token-0"));
  await expect(
    deploy(makeRecord(), "http://example", 1000, deps, () => {}),
  ).rejects.toMatchObject({
    code: "upstream_unavailable",
    message: "Network request failed during deploy",
  });
});
it("rejects unknown status and a mismatched release identity", async () => {
  for (const body of [
    release("unknown"),
    { ...release("healthy"), app: "other" },
  ]) {
    await expect(
      deploy(
        makeRecord(),
        "http://example",
        1000,
        harness([Response.json(body)]),
        () => {},
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  }
});
it("does not submit a late release after the token deadline expires", async () => {
  let now = 0;
  const deps = harness([]);
  const token = async () => {
    now = 200;
    return "private-token";
  };
  await expect(
    deploy(
      makeRecord(),
      "http://example",
      100,
      { ...deps, now: () => now, token },
      () => {},
    ),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(deps.fetch).not.toHaveBeenCalled();
});
it("rejects a release from another run even when version/app match", async () => {
  await expect(
    deploy(
      makeRecord(),
      "http://example",
      1000,
      harness([
        Response.json({ ...release("healthy"), release_id: "reader-124-1" }),
      ]),
      () => {},
    ),
  ).rejects.toMatchObject({ code: "invalid_response" });
});

it("preflights the exact component list with a fresh authenticated POST", async () => {
  const deps = harness([Response.json({ ok: true, components: { api: "ghcr.io/correctroadh/reader-api", web: "ghcr.io/correctroadh/reader-web" } })]);
  await expect(preflight("reader", ["api", "web"], "http://example", 10000, deps)).resolves.toBeUndefined();
  expect(deps.fetch.mock.calls[0][0]).toBe("http://example/v1/releases/check");
  expect(deps.fetch.mock.calls[0][1]).toMatchObject({
    method: "POST",
    headers: { Authorization: "Bearer private-token-0" },
    body: JSON.stringify({ app: "reader", components: ["api", "web"] }),
  });
  expect(deps.sleep).not.toHaveBeenCalled();
});
it.each([
  { revision: "short", state: "f".repeat(64) },
  { revision: "b".repeat(40), state: "F".repeat(64) },
  { revision: "b".repeat(40) },
])("ignores a malformed optional baseline %j", async (baseline) => {
  const deps = harness([Response.json({ ok: true, components: { app: "image" }, baseline })]);
  await expect(preflight("reader", ["app"], "http://example", 10000, deps)).resolves.toBeUndefined();
});
it("reports missing/unexpected component names without echoing server messages or tokens", async () => {
  const deps = harness([Response.json({
    code: "components_mismatch", phase: "request", message: "private-token-0",
    missing: ["agent", "private-token-0", "bad\nname"], unexpected: ["worker"],
  }, { status: 400 })]);
  try {
    await preflight("reader", ["api", "worker"], "http://example", 10000, deps);
    expect.fail("preflight should reject");
  } catch (error) {
    expect(error).toMatchObject({ code: "components_mismatch", phase: "request" });
    expect(String(error)).toContain('missing=["agent","[invalid]","[invalid]"]');
    expect(String(error)).toContain('unexpected=["worker"]');
    expect(String(error)).not.toContain("private-token-0");
  }
});
it.each(errorCodes)("preflight rejects deployer error %s", async (code) => {
  const deps = harness([Response.json({ code, phase: "authorization" }, { status: 403 })]);
  await expect(preflight("reader", ["app"], "http://example", 10000, deps)).rejects.toMatchObject({ code });
});
it.each([{}, { ok: true }, { ok: false, components: {} }, { ok: true, components: { other: "image" } }])(
  "preflight rejects malformed success response %j", async (body) => {
    await expect(preflight("reader", ["app"], "http://example", 10000, harness([Response.json(body)])))
      .rejects.toMatchObject({ code: "invalid_response" });
  },
);
it("preflight bounds OIDC acquisition and does not send a late request", async () => {
  const deps = harness([]);
  let complete!: (token: string) => void;
  const token = () => new Promise<string>((resolve) => { complete = resolve; });
  await expect(preflight("reader", ["app"], "http://example", 10, { ...deps, token }))
    .rejects.toMatchObject({ code: "timeout" });
  complete("private-token");
  await Promise.resolve();
  expect(deps.fetch).not.toHaveBeenCalled();
});
