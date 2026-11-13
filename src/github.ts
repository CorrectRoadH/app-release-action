import { readFile } from "node:fs/promises";
import { ActionError, type ReleaseRecord, timelineKeys } from "./model.js";
import { request, json, type Fetch } from "./http.js";
import { type Inputs, version } from "./inputs.js";
export function initialRecord(
  inputs: Inputs,
  env: NodeJS.ProcessEnv,
  now: Date,
): ReleaseRecord {
  const number = (key: string) => {
    const value = Number(env[key]);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new ActionError(
        "invalid_environment",
        "metadata",
        `Missing ${key}`,
      );
    return value;
  };
  const id = number("GITHUB_RUN_ID"),
    runNumber = number("GITHUB_RUN_NUMBER"),
    attempt = number("GITHUB_RUN_ATTEMPT");
  const repository = env.GITHUB_REPOSITORY || "";
  if (
    !/^[^/]+\/[^/]+$/.test(repository) ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || "")
  )
    throw new ActionError(
      "invalid_environment",
      "metadata",
      "Missing source repository or SHA",
    );
  const workflowRef = env.GITHUB_WORKFLOW_REF || "";
  const workflow = workflowRef.startsWith(`${repository}/`)
    ? workflowRef.slice(repository.length + 1).split("@")[0]
    : "";
  return {
    schema: "app-release/v1",
    release_id: "",
    app: inputs.app,
    version: version(now, runNumber, attempt),
    source: {
      repository,
      repository_id: number("GITHUB_REPOSITORY_ID"),
      revision: env.GITHUB_SHA!,
      ref: env.GITHUB_REF || "",
      actor: env.GITHUB_ACTOR || "",
      committed_at: null,
      upstream_revision: inputs.upstreamRevision || null,
    },
    run: {
      id,
      number: runNumber,
      attempt,
      workflow,
      runner: env.RUNNER_NAME || env.RUNNER_OS || "",
      url: `https://github.com/${repository}/actions/runs/${id}/attempts/${attempt}`,
    },
    components: [],
    timeline: Object.fromEntries(timelineKeys.map((key) => [key, null])),
    durations: {},
    result: { status: "failed", infra_commit: "", error: null },
  };
}
export async function metadata(
  record: ReleaseRecord,
  token: string,
  env: NodeJS.ProcessEnv,
  fetcher: Fetch,
): Promise<void> {
  const api = async (path: string): Promise<unknown> => {
    const response = await request(
      fetcher,
      `https://api.github.com/repos/${record.source.repository}/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      "metadata",
    );
    if (!response.ok)
      throw new ActionError(
        "github_api_failed",
        "metadata",
        "Could not read GitHub run metadata (actions: read permission is required)",
      );
    return json(response, "metadata");
  };
  const run = (await api(`actions/runs/${record.run.id}`)) as {
    created_at: string;
  };
  let committed: string | undefined;
  if (env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as {
      head_commit?: { timestamp?: string };
    };
    committed = event.head_commit?.timestamp;
  }
  if (!committed) {
    const commit = (await api(`commits/${record.source.revision}`)) as {
      commit: { committer: { date: string } };
    };
    committed = commit.commit.committer.date;
  }
  // Runner name identifies the current matrix job even when its display name differs from GITHUB_JOB.
  let started: string | undefined;
  for (let page = 1; page <= 100; page++) {
    const jobs = (await api(
      `actions/runs/${record.run.id}/attempts/${record.run.attempt}/jobs?per_page=100&page=${page}`,
    )) as {
      jobs: { runner_name: string; status: string; started_at: string }[];
    };
    started = jobs.jobs.find(
      (j) => j.runner_name === env.RUNNER_NAME && j.status === "in_progress",
    )?.started_at;
    if (started || jobs.jobs.length < 100) break;
  }
  if (!started)
    throw new ActionError(
      "github_api_failed",
      "metadata",
      "Could not identify the current job start time",
    );
  for (const value of [run.created_at, committed, started])
    if (!value || !Number.isFinite(Date.parse(value)))
      throw new ActionError(
        "invalid_response",
        "metadata",
        "Invalid GitHub timestamp",
      );
  record.source.committed_at = new Date(committed!).toISOString();
  record.timeline.committed = record.source.committed_at;
  record.timeline.run_created = new Date(run.created_at).toISOString();
  record.timeline.job_started = new Date(started).toISOString();
}
