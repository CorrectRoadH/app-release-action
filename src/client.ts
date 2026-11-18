import {
  ActionError,
  commitShaPattern,
  type ReleaseError,
  type ReleaseRecord,
  type Timeline,
} from "./model.js";
import { request, json, type Fetch } from "./http.js";
export const statuses = [
  "queued",
  "accepted",
  "writing",
  "syncing",
  "rolling_out",
  "healthy",
  "noop",
  "superseded",
  "failed",
] as const;
export const errorCodes = [
  "unauthenticated",
  "app_not_registered",
  "identity_mismatch",
  "invalid_request",
  "components_mismatch",
  "version_mismatch",
  "superseded",
  "base_changed",
  "image_not_found",
  "platform_mismatch",
  "revision_mismatch",
  "tag_mismatch",
  "write_conflict",
  "release_not_found",
  "sync_timeout",
  "degraded",
  "upstream_unavailable",
] as const;
export interface Release {
  release_id: string;
  app: string;
  version: string;
  status: string;
  infra_commit: string;
  timeline: Timeline;
  error: ReleaseError | null;
}
interface Baseline {
  revision: string;
  state: string;
}
export interface IncrementalRelease extends Baseline {
  retain: string[];
}
export interface ClientDependencies {
  fetch: Fetch;
  token: () => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
function safeError(body: unknown, token = ""): ActionError {
  const error = body as (Partial<ReleaseError> & {
    missing?: unknown;
    unexpected?: unknown;
  }) | null;
  const code = errorCodes.find((c) => c === error?.code) || "invalid_response";
  // The server's free-form message is untrusted and may echo an Authorization header.
  const phase = [
    "auth",
    "authentication",
    "authorization",
    "validation",
    "request",
    "identity",
    "image",
    "images",
    "queue",
    "write_back",
    "sync",
    "rollout",
    "deploy",
  ].includes(error?.phase ?? "")
    ? error!.phase!
    : "deploy";
  const names = (value: unknown): string => {
    if (!Array.isArray(value)) return "[invalid]";
    return JSON.stringify(
      value.slice(0, 100).map((name: unknown) =>
        typeof name === "string" &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) &&
        name.length <= 128 && !(token && name.includes(token))
          ? name : "[invalid]",
      ),
    );
  };
  const detail = code === "components_mismatch"
    ? `; missing=${names(error?.missing)}; unexpected=${names(error?.unexpected)}`
    : "";
  return new ActionError(
    code, phase, `Deployer returned ${code} during ${phase}${detail}`,
  );
}
function release(body: unknown): Release {
  const r = body as Release | null;
  if (
    !r ||
    !statuses.includes(r.status as (typeof statuses)[number]) ||
    !/^[a-z0-9-]+-\d+-\d+$/.test(r.release_id) ||
    typeof r.app !== "string" ||
    typeof r.version !== "string" ||
    (r.infra_commit != null &&
      r.infra_commit !== "" &&
      !/^[a-f0-9]{40}$/.test(r.infra_commit))
  ) {
    throw new ActionError(
      "invalid_response",
      "deploy",
      "Invalid release response",
    );
  }
  const timeline: Timeline = {};
  for (const key of ["deploy_requested", "written_back", "synced", "healthy"]) {
    const value = r.timeline?.[key];
    if (
      value != null &&
      (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    )
      throw new ActionError(
        "invalid_response",
        "deploy",
        "Invalid release timeline",
      );
    timeline[key] = value ?? null;
  }
  return {
    release_id: r.release_id,
    app: r.app,
    version: r.version,
    status: r.status,
    infra_commit: r.infra_commit || "",
    timeline,
    error: r.error ? safeError(r.error).toJSON() : null,
  };
}
async function callDeployer(
  origin: string,
  path: string,
  body: unknown,
  deadline: number,
  deps: ClientDependencies,
): Promise<unknown> {
  const remaining = deadline - deps.now();
  if (remaining <= 0)
    throw new ActionError(
      "timeout",
      "deploy",
      "Timed out waiting for release",
    );
  // Include token acquisition in the deadline, even if the identity provider hangs.
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const token = await deps.token();
        if (expired || deps.now() >= deadline)
          throw new ActionError(
            "timeout",
            "deploy",
            "Timed out waiting for release",
          );
        const response = await request(
          deps.fetch,
          `${origin}${path}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          "deploy",
          Math.min(30000, Math.max(1, deadline - deps.now())),
        );
        const data = await json(response, "deploy");
        if (!response.ok) throw safeError(data, token);
        if (expired || deps.now() >= deadline)
          throw new ActionError(
            "timeout",
            "deploy",
            "Timed out waiting for release",
          );
        return data;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            expired = true;
            reject(
              new ActionError(
                "timeout",
                "deploy",
                "Timed out waiting for release",
              ),
            );
          },
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function preflight(
  app: string,
  components: string[],
  origin: string,
  timeoutMs: number,
  deps: ClientDependencies,
): Promise<Baseline | undefined> {
  const data = await callDeployer(
    origin, "/v1/releases/check", { app, components }, deps.now() + timeoutMs, deps,
  );
  const result = data as {
    ok?: unknown;
    components?: Record<string, unknown>;
    baseline?: { revision?: unknown; state?: unknown } | null;
  } | null;
  if (
    result?.ok !== true || !result.components ||
    typeof result.components !== "object" || Array.isArray(result.components) ||
    Object.keys(result.components).length !== components.length ||
    components.some((name) => typeof result.components?.[name] !== "string")
  ) {
    throw new ActionError("invalid_response", "deploy", "Invalid preflight response");
  }
  const { revision, state } = result.baseline ?? {};
  if (
    typeof revision === "string" && commitShaPattern.test(revision) &&
    typeof state === "string" && /^[a-f0-9]{64}$/.test(state)
  ) return { revision, state };
}

export async function deploy(
  record: ReleaseRecord,
  origin: string,
  timeoutMs: number,
  deps: ClientDependencies,
  update: (r: Release) => void,
  incremental?: IncrementalRelease,
): Promise<Release> {
  const deadline = deps.now() + timeoutMs;
  const call = async (path: string, body?: unknown): Promise<Release> => {
    const data = await callDeployer(origin, path, body, deadline, deps);
    const r = release(data);
    if (
      r.app !== record.app ||
      r.version !== record.version ||
      r.release_id !==
        `${record.app}-${record.run.id}-${record.run.attempt}` ||
      (record.release_id && r.release_id !== record.release_id)
    ) {
      throw new ActionError(
        "invalid_response",
        "deploy",
        "Release identity does not match request",
      );
    }
    update(r);
    return r;
  };
  let r = await call("/v1/releases", {
    app: record.app,
    version: record.version,
    components: Object.fromEntries(
      record.components.map((c) => [
        c.name,
        { image: c.image, digest: c.digest },
      ]),
    ),
    incremental,
    build: {
      source: record.source,
      run: record.run,
      components: record.components,
      timeline: record.timeline,
    },
  });
  while (!["healthy", "noop", "superseded", "failed"].includes(r.status)) {
    const remaining = deadline - deps.now();
    if (remaining <= 0)
      throw new ActionError(
        "timeout",
        "deploy",
        "Timed out waiting for release",
      );
    await deps.sleep(Math.min(5000, remaining));
    r = await call(`/v1/releases/${encodeURIComponent(r.release_id)}`);
  }
  if (!["healthy", "noop"].includes(r.status))
    throw r.error
      ? new ActionError(r.error.code, r.error.phase, r.error.message)
      : new ActionError(r.status, "deploy", `Release ended as ${r.status}`);
  return r;
}
