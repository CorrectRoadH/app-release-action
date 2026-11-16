import { expect, it } from "vitest";
import { buildSecretOptions, parseBuildSecrets } from "../src/build-secrets.js";
import { run } from "../src/process.js";

it("passes nonempty secrets only through a child environment", () => {
  const secrets = parseBuildSecrets("SENTRY_AUTH_TOKEN=secret=value\nOPTIONAL=\n");
  const { args, env } = buildSecretOptions(secrets, { PATH: "/bin" });
  expect(args).toEqual(["--secret", "id=SENTRY_AUTH_TOKEN,env=APP_RELEASE_BUILD_SECRET_0"]);
  expect(args.join(" ")).not.toContain("secret=value");
  expect(env).toEqual({ PATH: "/bin", APP_RELEASE_BUILD_SECRET_0: "secret=value" });
  expect(process.env.APP_RELEASE_BUILD_SECRET_0).toBeUndefined();
});

it.each(["bad,key=secret", "A=one\nA=two", "missing-equals", "A=secret\u0000value"])("rejects malformed secret mappings without echoing them", (input) => {
  expect(() => parseBuildSecrets(input)).toThrow("Invalid build secrets");
  try { parseBuildSecrets(input); } catch (error) { expect(String(error)).not.toContain(input); }
});

it("does not attach secret-bearing build output to failures", async () => {
  await expect(run(process.execPath, ["-e", "console.error(process.env.TEST_SECRET); process.exit(1)"], {
    phase: "build", env: { ...process.env, TEST_SECRET: "sensitive-sentinel" }, suppressFailureDetail: true,
  })).rejects.toMatchObject({ code: "process_failed", detail: undefined });
});
