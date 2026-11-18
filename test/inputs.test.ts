import { describe, it, expect, vi } from "vitest";
import { parseInputs, imageName, version } from "../src/inputs.js";
const valid = {
  app: "reader",
  components: "- name: app",
  deploy: "false",
  "image-prefix": "ghcr.io/example/reader",
};
const parse = (overrides: Record<string, string | undefined> = {}) =>
  parseInputs(
    (k) => ({ ...valid, ...overrides })[k as keyof typeof valid] || "",
  );
describe("inputs and version", () => {
  it("uses component defaults and does not require Tailnet for build-only", () => {
    expect(parse().components).toEqual([
      {
        name: "app",
        context: ".",
        dockerfile: "./Dockerfile",
        buildArgs: [],
        target: undefined,
      },
    ]);
    expect(parse().platform).toBe("linux/arm64");
    expect(parse().timeoutMs).toBe(900000);
  });
  it("defaults the image namespace to the lowercase repository owner", () => {
    vi.stubEnv("GITHUB_REPOSITORY_OWNER", "Example-Owner");
    expect(parse({ "image-prefix": "" }).imagePrefix).toBe(
      "ghcr.io/example-owner/reader",
    );
    vi.unstubAllEnvs();
  });
  it("requires image-prefix when the repository owner is unknown", () => {
    vi.stubEnv("GITHUB_REPOSITORY_OWNER", "");
    expect(() => parse({ "image-prefix": "" })).toThrow(/image-prefix/);
    vi.unstubAllEnvs();
  });
  it("requires an explicit deployer-url for deployment", () => {
    expect(() =>
      parse({
        deploy: "true",
        "tailscale-client-id": "public-id",
        "tailscale-audience": "public-aud",
      }),
    ).toThrow(/deployer-url/);
  });
  it("accepts every component field and deployment input", () => {
    const i = parse({
      components:
        "- name: api\n  context: api\n  dockerfile: api/Dockerfile.prod\n  target: runtime\n  build-args: |\n    A=one=two\n    B=two",
      deploy: "true",
      "tailscale-client-id": "public-id",
      "tailscale-audience": "public-aud",
      "deployer-url": "http://deployer.example:2224",
      timeout: "30s",
      "upstream-revision": "a".repeat(40),
    });
    expect(i.components[0]).toEqual({
      name: "api",
      context: "api",
      dockerfile: "api/Dockerfile.prod",
      target: "runtime",
      buildArgs: ["A=one=two", "B=two"],
    });
    expect(i.timeoutMs).toBe(30000);
    expect(i.deploy).toBe(true);
  });
  it("keeps the complete component list when incremental inputs are present", () => {
    const base = "a".repeat(40);
    const i = parse({
      components: "- name: api\n- name: web",
      "incremental-base": base,
      "changed-components": '["web"]',
    });
    expect(i.incrementalBase).toBe(base);
    expect(i.changedComponents).toEqual(["web"]);
    expect(i.components.map((c) => c.name)).toEqual(["api", "web"]);
  });
  it.each(["app", '"app"', '{}', '[null]', '[1]', '["app","app"]', '["unknown"]'])(
    "rejects invalid changed-components %s",
    (value) => expect(() => parse({ "changed-components": value })).toThrow(/changed-components/),
  );
  it.each([
    { app: "Reader" },
    { components: "[]" },
    { components: "not: list" },
    { components: "[" },
    { components: "- name: app\n- name: app" },
    { components: "- name: app\n  typo: yes" },
    { components: "- name: app\n  context: -flag" },
    { components: "- name: app\n  build-args: invalid" },
    { components: "- name: app\n  build-args: [A=B]" },
    { platform: "linux/arm64,linux/amd64" },
    { "image-prefix": "ghcr.io/UPPER/app" },
    { "image-prefix": "ghcr.io/example/app:latest" },
    { deploy: "yes" },
    { deploy: "true" },
    { timeout: "0s" },
    { timeout: "-1m" },
    { timeout: "no" },
    { "deployer-url": "http://user:pass@localhost" },
    { "upstream-revision": "short" },
    { "incremental-base": "short" },
    { "incremental-base": "A".repeat(40) },
  ])("rejects invalid input %j", (values) =>
    expect(() => parse(values)).toThrow(),
  );
  it("names a single app image and multi-component images exactly", () => {
    expect(imageName("ghcr.io/example/reader", "app", 1)).toBe(
      "ghcr.io/example/reader",
    );
    expect(imageName("ghcr.io/example/reader", "api", 1)).toBe(
      "ghcr.io/example/reader-api",
    );
    expect(imageName("ghcr.io/example/reader", "app", 2)).toBe(
      "ghcr.io/example/reader-app",
    );
  });
  it("uses UTC without zero padding and increments attempts", () => {
    expect(version(new Date("2026-01-03T23:00:00-08:00"), 42, 1)).toBe(
      "2026.1.4-42.1",
    );
    expect(version(new Date("2026-01-04T00:00:00Z"), 42, 2)).toBe(
      "2026.1.4-42.2",
    );
    expect(() => version(new Date(), 0, 1)).toThrow();
  });
});
describe("network", () => {
  it("allows direct deployment without Tailscale inputs", () => {
    const i = parse({ deploy: "true", network: "direct", "deployer-url": "http://deployer.example:2224" });
    expect(i.network).toBe("direct");
  });
  it("still requires Tailscale inputs in tailscale mode and rejects unknown modes", () => {
    expect(() => parse({ deploy: "true", "deployer-url": "http://d.example" })).toThrow(/tailscale-client-id/);
    expect(() => parse({ network: "vpn" })).toThrow(/network/);
  });
});
