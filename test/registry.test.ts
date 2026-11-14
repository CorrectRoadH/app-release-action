import { it, expect, vi } from "vitest";
import { Registry } from "../src/registry.js";
import { oidc } from "../src/http.js";
import { run } from "../src/process.js";
it.each([
  [200, true],
  [404, false],
])("classifies HEAD %i", async (status, exists) => {
  const calls: { url: string; method?: string }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return String(url).includes("/token?")
      ? Response.json({ token: "secret" })
      : new Response(null, { status: Number(status) });
  };
  const registry = new Registry("owner/image", "actor", "secret", fetcher);
  expect(await registry.exists("sha256:" + "a".repeat(64))).toBe(exists);
  expect(calls[1].method).toBe("HEAD");
});
it.each([401, 403, 429, 500])(
  "does not count registry error %i as a missing layer",
  async (status) => {
    const registry = new Registry(
      "owner/image",
      "actor",
      "secret",
      async (url) =>
        String(url).includes("/token?")
          ? Response.json({ token: "secret" })
          : new Response(null, { status }),
    );
    await expect(
      registry.exists("sha256:" + "a".repeat(64)),
    ).rejects.toMatchObject({ code: "registry_head_failed" });
  },
);
it.each(["network", "unavailable"])(
  "recovers from one transient registry %s failure",
  async (failure) => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const registry = new Registry("owner/image", "actor", "secret", async (url) => {
        if (String(url).includes("/token?")) return Response.json({ token: "secret" });
        if (++reads === 1) {
          if (failure === "network") throw new TypeError("fetch failed");
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 200 });
      });
      const result = registry.exists("sha256:" + "a".repeat(64));
      await vi.runAllTimersAsync();
      expect(await result).toBe(true);
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  },
);
it("bounds network retries and never treats an unreachable registry as a missing layer", async () => {
  vi.useFakeTimers();
  try {
    let reads = 0;
    const registry = new Registry("owner/image", "actor", "secret", async (url) => {
      if (String(url).includes("/token?")) return Response.json({ token: "secret" });
      reads++;
      throw new TypeError("fetch failed with private-token");
    });
    const rejected = expect(registry.exists("sha256:" + "a".repeat(64)))
      .rejects.toMatchObject({ code: "upstream_unavailable", message: "Network request failed during registry" });
    await vi.runAllTimersAsync();
    await rejected;
    expect(reads).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});
it("rejects an already-published immutable tag", async () => {
  const registry = new Registry(
    "owner/image",
    "actor",
    "secret",
    async (url) =>
      String(url).includes("/token?")
        ? Response.json({ token: "secret" })
        : new Response(null, { status: 200 }),
  );
  await expect(registry.assertNewTag("2026.1.1-1.1")).rejects.toMatchObject({
    code: "tag_exists",
  });
});
it("requests OIDC with the exact audience without logging or writing a credential", async () => {
  vi.stubEnv(
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "https://oidc.example/?existing=1",
  );
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-secret");
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ value: "oidc-secret" }),
  );
  expect(await oidc("app-deployer", fetcher)).toBe("oidc-secret");
  expect(String(fetcher.mock.calls[0][0])).toContain("audience=app-deployer");
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({
    Authorization: "Bearer request-secret",
  });
  vi.unstubAllEnvs();
});
it("suppresses command output and exceptions containing secrets", async () => {
  await expect(
    run(
      process.execPath,
      ["-e", 'process.stderr.write("private-token");process.exit(1)'],
      { phase: "test" },
    ),
  ).rejects.toMatchObject({ message: "Command failed during test" });
});
it("kills a timed-out process", async () => {
  await expect(
    run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      phase: "test",
      timeoutMs: 10,
    }),
  ).rejects.toMatchObject({ code: "process_failed" });
});
it("keeps the tail of a failed build's output and nothing for other phases", async () => {
  const script = "console.log('step 1'); console.error('ERROR: pip failed'); process.exit(1)";
  await expect(
    run(process.execPath, ["-e", script], { phase: "build" }),
  ).rejects.toMatchObject({ detail: expect.stringContaining("ERROR: pip failed") });
  await expect(
    run(process.execPath, ["-e", script], { phase: "push" }),
  ).rejects.toMatchObject({ detail: undefined });
});
