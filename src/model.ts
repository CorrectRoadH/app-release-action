export interface ReleaseError {
  code: string;
  message: string;
  phase: string;
}
export const commitShaPattern = /^[a-f0-9]{40}$/;
export type Timeline = Record<string, string | null>;
export interface ComponentRecord {
  name: string;
  image: string;
  digest: string;
  platform: string;
  layers: number;
  layers_reused: number;
  image_bytes: number;
  pushed_bytes: number;
  cache_hit_steps: number;
  cache_miss_steps: number;
  build_seconds: number;
  push_seconds: number;
}
export interface ReleaseRecord {
  schema: "app-release/v1";
  release_id: string;
  app: string;
  version: string;
  source: {
    repository: string;
    repository_id: number;
    revision: string;
    ref: string;
    actor: string;
    committed_at: string | null;
    upstream_revision: string | null;
  };
  run: {
    id: number;
    number: number;
    attempt: number;
    workflow: string;
    runner: string;
    url: string;
  };
  components: ComponentRecord[];
  timeline: Timeline;
  durations: Record<string, number | null>;
  result: { status: string; infra_commit: string; error: ReleaseError | null };
}
export const timelineKeys = [
  "committed",
  "run_created",
  "job_started",
  "build_started",
  "build_finished",
  "push_started",
  "push_finished",
  "deploy_requested",
  "written_back",
  "synced",
  "healthy",
] as const;
export function durations(t: Timeline): Record<string, number | null> {
  const pairs: Record<string, [string, string]> = {
    queue: ["run_created", "job_started"],
    build: ["build_started", "build_finished"],
    push: ["push_started", "push_finished"],
    write_back: ["deploy_requested", "written_back"],
    sync: ["written_back", "synced"],
    rollout: ["synced", "healthy"],
    lead_time: ["committed", "healthy"],
  };
  return Object.fromEntries(
    Object.entries(pairs).map(([key, [from, to]]) => {
      const a = t[from] ? Date.parse(t[from]) : NaN;
      const b = t[to] ? Date.parse(t[to]) : NaN;
      return [
        key,
        Number.isFinite(a) && Number.isFinite(b) && b >= a
          ? (b - a) / 1000
          : null,
      ];
    }),
  );
}
export class ActionError extends Error {
  constructor(
    public code: string,
    public phase: string,
    message: string,
    /** Tail of a failed build's output, shown to the workflow log only. */
    public detail?: string,
  ) {
    super(message);
  }
  toJSON(): ReleaseError {
    return { code: this.code, phase: this.phase, message: this.message };
  }
}
export function failure(error: unknown, phase: string): ActionError {
  // Never propagate arbitrary HTTP/process errors: they can contain bearer tokens.
  return error instanceof ActionError
    ? error
    : new ActionError("action_failed", phase, `Action failed during ${phase}`);
}
export function summary(record: ReleaseRecord): string {
  const cell = (v: unknown) => String(v ?? "—").replace(/[|\r\n<>]/g, " ");
  const rows = [
    ["Version", record.version],
    ["Status", record.result.status],
    ["Infrastructure commit", record.result.infra_commit || "—"],
    ...Object.entries(record.durations).map(([k, v]) => [`${k} (seconds)`, v]),
    [
      "Pushed bytes",
      record.components.reduce((sum, c) => sum + c.pushed_bytes, 0),
    ],
    [
      "Reused layers",
      `${record.components.reduce((sum, c) => sum + c.layers_reused, 0)} / ${record.components.reduce((sum, c) => sum + c.layers, 0)}`,
    ],
    ["Error code", record.result.error?.code],
    ["Failed phase", record.result.error?.phase],
  ];
  return `## Application release\n\n| Field | Value |\n| --- | --- |\n${rows.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n")}\n`;
}
