import { imageName, type Inputs } from "./inputs.js";
import { ActionError, commitShaPattern, type ComponentRecord, type ReleaseRecord } from "./model.js";
import type { IncrementalRelease } from "./client.js";

export type Stage = "release" | "plan" | "build" | "finalize";
const metadataKeys = ["committed", "run_created", "job_started"] as const;
const buildKeys = ["build_started", "build_finished", "push_started", "push_finished"] as const;
type Times<K extends string> = Record<K, string>;

interface Identity {
  app: string;
  repository: string;
  revision: string;
  runId: number;
  attempt: number;
  version: string;
}

export interface Plan extends Identity {
  names: string[];
  incremental?: IncrementalRelease;
  metadata: Times<(typeof metadataKeys)[number]>;
  runner: string;
}

interface BuildResult extends Identity {
  component: ComponentRecord;
  timeline: Times<(typeof buildKeys)[number]>;
}

function invalid(message: string): never {
  throw new ActionError("invalid_stage_input", "inputs", message);
}

export function readStage(value: string): Stage {
  switch (value || "release") {
    case "release": return "release";
    case "plan": return "plan";
    case "build": return "build";
    case "finalize": return "finalize";
    default: return invalid("stage must be release, plan, build, or finalize");
  }
}

function decode(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalid("Expected JSON from a preceding release stage");
  }
}

function identity(record: ReleaseRecord): Identity {
  return {
    app: record.app,
    repository: record.source.repository,
    revision: record.source.revision,
    runId: record.run.id,
    attempt: record.run.attempt,
    version: record.version,
  };
}

function matchesRun(value: Identity, record: ReleaseRecord): boolean {
  const { version, ...current } = identity(record);
  return Object.entries(current).every(([k, v]) => value[k as keyof Identity] === v)
    && typeof value.version === "string"
    && /^\d{4}\.\d{1,2}\.\d{1,2}-\d+\.\d+$/.test(value.version)
    && value.version.slice(value.version.indexOf("-")) === version.slice(version.indexOf("-"));
}

function times<K extends string>(keys: readonly K[], timeline: ReleaseRecord["timeline"]): Times<K> {
  return Object.fromEntries(keys.map((key) => [key, timeline[key]])) as Times<K>;
}

function hasTimes<K extends string>(keys: readonly K[], value: Times<K> | undefined): boolean {
  return !!value && keys.every((key) =>
    typeof value[key] === "string" &&
    Number.isFinite(Date.parse(value[key])) &&
    new Date(value[key]).toISOString() === value[key],
  );
}

export function createPlan(record: ReleaseRecord, names: string[], incremental?: IncrementalRelease): Plan {
  return {
    ...identity(record),
    names,
    incremental,
    metadata: times(metadataKeys, record.timeline),
    runner: record.run.runner,
  };
}

export function readPlan(raw: string, inputs: Inputs, record: ReleaseRecord): Plan {
  const plan = decode(raw) as Plan | null;
  if (!plan || !matchesRun(plan, record))
    return invalid("Plan belongs to a different release run or attempt. Re-run all jobs.");
  const configured = inputs.components.map(({ name }) => name);
  const incremental = plan.incremental;
  const retain = incremental?.retain ?? [];
  if (
    !Array.isArray(plan.names) || !plan.names.length || !hasTimes(metadataKeys, plan.metadata) ||
    typeof plan.runner !== "string" ||
    (incremental !== undefined && (
      !incremental || typeof incremental.revision !== "string" || !commitShaPattern.test(incremental.revision) ||
      typeof incremental.state !== "string" || !/^[a-f0-9]{64}$/.test(incremental.state) ||
      !Array.isArray(incremental.retain) || !retain.length
    )) ||
    new Set([...plan.names, ...retain]).size !== configured.length ||
    plan.names.length + retain.length !== configured.length ||
    configured.some((name) => !plan.names.includes(name) && !retain.includes(name))
  ) return invalid("Plan must partition the configured release components");
  record.version = plan.version;
  return {
    ...plan,
    incremental: incremental && { revision: incremental.revision, state: incremental.state, retain },
  };
}

export function createBuildResult(record: ReleaseRecord): BuildResult {
  return {
    ...identity(record),
    component: record.components[0],
    timeline: times(buildKeys, record.timeline),
  };
}

const stats = [
  "layers", "layers_reused", "image_bytes", "pushed_bytes", "cache_hit_steps",
  "cache_miss_steps", "build_seconds", "push_seconds",
] as const;

export function collectBuilds(raw: string, plan: Plan, inputs: Inputs, record: ReleaseRecord): void {
  const results = decode(raw) as (BuildResult | null)[];
  if (!Array.isArray(results) || results.length !== plan.names.length)
    return invalid("Expected exactly one build result for each planned component");
  for (const result of results) {
    if (!result || !matchesRun(result, record) || result.version !== plan.version)
      return invalid("Build result belongs to a different release run, attempt, or version. Re-run all jobs.");
    const c = result.component;
    if (
      !c || !plan.names.includes(c.name) ||
      c.image !== imageName(inputs.imagePrefix, c.name, inputs.components.length) ||
      c.platform !== inputs.platform || typeof c.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(c.digest) ||
      stats.some((key) => !Number.isFinite(c[key]) || c[key] < 0) ||
      !hasTimes(buildKeys, result.timeline) ||
      buildKeys.some((key, i) => i > 0 && result.timeline[buildKeys[i - 1]] > result.timeline[key])
    ) return invalid("Invalid planned component build result");
  }
  const ordered = plan.names.map((name) => results.find((result) => result?.component.name === name));
  if (ordered.some((result) => !result))
    return invalid("Expected exactly one build result for each planned component");

  for (const key of metadataKeys) record.timeline[key] = plan.metadata[key];
  record.source.committed_at = plan.metadata.committed;
  record.run.runner = plan.runner;
  for (const result of ordered) {
    const { component, timeline } = result!;
    const { name, image, digest, platform } = component;
    record.components.push({
      name, image, digest, platform,
      layers: component.layers,
      layers_reused: component.layers_reused,
      image_bytes: component.image_bytes,
      pushed_bytes: component.pushed_bytes,
      cache_hit_steps: component.cache_hit_steps,
      cache_miss_steps: component.cache_miss_steps,
      build_seconds: component.build_seconds,
      push_seconds: component.push_seconds,
    });
    for (const key of buildKeys) {
      const current = record.timeline[key];
      const value = timeline[key];
      const earlier = key === "build_started" || key === "push_started";
      if (!current || (earlier ? value < current : value > current)) record.timeline[key] = value;
    }
  }
}
