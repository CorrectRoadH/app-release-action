import { parse } from "yaml";
import { ActionError } from "./model.js";
export interface Component {
  name: string;
  context: string;
  dockerfile: string;
  target?: string;
  buildArgs: string[];
}
export interface Inputs {
  app: string;
  components: Component[];
  platform: string;
  imagePrefix: string;
  deployerUrl: string;
  tailscaleClientId: string;
  tailscaleAudience: string;
  upstreamRevision?: string;
  deploy: boolean;
  timeoutMs: number;
}
const invalid = (message: string): never => {
  throw new ActionError("invalid_input", "inputs", message);
};
const name = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
function string(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value))
    return invalid(`Invalid ${label}`);
  return value.trim();
}
export function parseInputs(get: (name: string) => string): Inputs {
  const app = string(get("app"), "app");
  if (!name.test(app))
    invalid("app must contain lowercase letters, digits and hyphens");
  let raw: unknown;
  try {
    raw = parse(get("components"), { maxAliasCount: 0 });
  } catch {
    return invalid("components must be valid YAML");
  }
  if (!Array.isArray(raw) || raw.length === 0)
    invalid("components must be a nonempty YAML list");
  const seen = new Set<string>();
  const components = (raw as unknown[]).map((value): Component => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return invalid("Invalid component");
    const c = value as Record<string, unknown>;
    if (
      Object.keys(c).some(
        (k) =>
          !["name", "context", "dockerfile", "target", "build-args"].includes(
            k,
          ),
      )
    )
      invalid("Unknown component field");
    const n = string(c.name, "component name");
    if (!name.test(n) || seen.has(n))
      invalid("Component names must be valid and unique");
    seen.add(n);
    const context = string(c.context, "context", ".");
    const dockerfile = string(
      c.dockerfile,
      "dockerfile",
      `${context.replace(/\/$/, "")}/Dockerfile`,
    );
    if (context.startsWith("-") || dockerfile.startsWith("-"))
      invalid("Paths must not start with a dash");
    const buildArgs: string[] = [];
    if (c["build-args"] !== undefined) {
      if (typeof c["build-args"] !== "string")
        invalid("build-args must be multiline KEY=VALUE");
      for (const arg of (c["build-args"] as string)
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*=[^\0]*$/.test(arg))
          invalid("Invalid build argument");
        buildArgs.push(arg);
      }
    }
    return {
      name: n,
      context,
      dockerfile,
      target: c.target === undefined ? undefined : string(c.target, "target"),
      buildArgs,
    };
  });
  const platform = get("platform") || "linux/arm64";
  if (!/^linux\/(amd64|arm64)(\/v[0-9]+)?$/.test(platform))
    invalid("platform must be a single Linux amd64 or arm64 platform");
  const owner = (process.env.GITHUB_REPOSITORY_OWNER || "").toLowerCase();
  const imagePrefix = get("image-prefix") || `ghcr.io/${owner}/${app}`;
  if (!get("image-prefix") && !owner)
    invalid("image-prefix is required outside GitHub Actions");
  if (
    get("image-prefix") &&
    !/^ghcr\.io\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(
      imagePrefix,
    )
  )
    invalid(
      "image-prefix must be a lowercase GHCR image repository without a tag",
    );
  const deploy = get("deploy") || "true";
  if (!["true", "false"].includes(deploy))
    invalid("deploy must be true or false");
  const tailscaleClientId = get("tailscale-client-id");
  const tailscaleAudience = get("tailscale-audience");
  if (deploy === "true" && (!tailscaleClientId || !tailscaleAudience))
    invalid("deploy=true requires tailscale-client-id and tailscale-audience");
  const deployerUrl = get("deployer-url");
  if (deploy === "true" && !deployerUrl)
    invalid("deploy=true requires deployer-url");
  const timeout = /^(\d+)(s|m|h)$/.exec(get("timeout") || "15m");
  const timeoutMs = timeout
    ? Number(timeout[1]) * ({ s: 1000, m: 60000, h: 3600000 }[timeout[2]] ?? 0)
    : 0;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 86400000
  )
    invalid("timeout must be a positive duration up to 24h (s, m or h)");
  if (deployerUrl) try {
    const url = new URL(deployerUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      invalid("deployer-url must be an HTTP(S) origin");
  } catch {
    invalid("Invalid deployer-url");
  }
  const upstreamRevision = get("upstream-revision") || undefined;
  if (
    upstreamRevision &&
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(upstreamRevision)
  )
    invalid("upstream-revision must be a full lowercase commit SHA");
  return {
    app,
    components,
    platform,
    imagePrefix,
    deployerUrl: deployerUrl.replace(/\/$/, ""),
    tailscaleClientId,
    tailscaleAudience,
    upstreamRevision,
    deploy: deploy === "true",
    timeoutMs,
  };
}
export function imageName(
  prefix: string,
  component: string,
  count: number,
): string {
  return count === 1 && component === "app" ? prefix : `${prefix}-${component}`;
}
export function version(
  date: Date,
  runNumber: number,
  attempt: number,
): string {
  if (
    !Number.isSafeInteger(runNumber) ||
    runNumber < 1 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    invalid("Invalid GitHub run number/attempt");
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}-${runNumber}.${attempt}`;
}
