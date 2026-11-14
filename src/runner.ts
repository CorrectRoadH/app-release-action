import { mkdir, mkdtemp, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import { setTimeout as sleep } from "node:timers/promises";
import { parseInputs } from "./inputs.js";
import { initialRecord } from "./github.js";
import {
  type ReleaseRecord,
  ActionError,
  durations,
  failure,
  summary,
  timelineKeys,
} from "./model.js";
import { execute, type Dependencies } from "./action.js";
import { run } from "./process.js";
import { installRegctl, prepareTailscale } from "./tools.js";
import { cleanupTailscale, existingTailscale } from "./tailscale.js";
export interface Reporter {
  input: (name: string) => string;
  output: (name: string, value: string) => void;
  state: (key: string, value: string) => void;
  log: (message: string) => void;
  failed: (message: string) => void;
  artifact: (path: string, root: string) => Promise<void>;
}
export const reporter: Reporter = {
  input: core.getInput,
  output: core.setOutput,
  state: core.saveState,
  log: core.info,
  failed: core.setFailed,
  artifact: async (path, root) => {
    const quotaMarker = `${path}.quota-exceeded`;
    await rm(quotaMarker, { force: true });
    await run(process.execPath, [join(__dirname, "artifact.cjs"), path, root], {
      phase: "artifact",
      timeoutMs: 120000,
    });
    if (existsSync(quotaMarker)) {
      if (!process.env.GITHUB_STEP_SUMMARY)
        throw new ActionError(
          "artifact_quota_exceeded",
          "artifact",
          "Artifact storage quota exhausted and no job summary is available",
        );
      const record = (await readFile(path, "utf8")).replaceAll("<", "\\u003c");
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `\nArtifact storage quota exhausted. The complete release record is preserved below.\n\n<details><summary>Full release record</summary>\n\n\`\`\`json\n${record}\`\`\`\n\n</details>\n`,
      );
      core.warning(
        "artifact_quota_exceeded: GitHub artifact storage is full; the complete release record is in the job summary. Release status is unchanged.",
      );
      await rm(quotaMarker);
    }
  },
};
export async function runAction(
  report: Reporter = reporter,
  overrides: Partial<Dependencies> = {},
): Promise<void> {
  const env = process.env;
  if (!env.RUNNER_TEMP) {
    report.failed("invalid_environment during setup: RUNNER_TEMP is required");
    return;
  }
  const directory = join(env.RUNNER_TEMP, "app-release");
  const recordPath = join(directory, "record.json");
  await mkdir(directory, { recursive: true });
  const work = await mkdtemp(join(directory, "work-"));
  const states = new Map<string, string>();
  const state = (key: string, value: string) => {
    states.set(key, value);
    report.state(key, value);
  };
  state("work", work);
  const deps: Dependencies = {
    exec: run,
    fetch,
    now: () => new Date(),
    sleep: (ms) => sleep(ms),
    state,
    log: report.log,
    installRegctl,
    prepareTailscale,
    existingTailscale,
    ...overrides,
  };
  // A partial record still provides an artifact and failure phase for invalid inputs or missing metadata.
  let record: ReleaseRecord = {
    schema: "app-release/v1",
    release_id: "",
    app: "",
    version: "",
    source: {
      repository: env.GITHUB_REPOSITORY || "",
      repository_id: Number(env.GITHUB_REPOSITORY_ID) || 0,
      revision: env.GITHUB_SHA || "",
      ref: env.GITHUB_REF || "",
      actor: env.GITHUB_ACTOR || "",
      committed_at: null,
      upstream_revision: null,
    },
    run: {
      id: Number(env.GITHUB_RUN_ID) || 0,
      number: Number(env.GITHUB_RUN_NUMBER) || 0,
      attempt: Number(env.GITHUB_RUN_ATTEMPT) || 0,
      workflow: "",
      runner: env.RUNNER_NAME || "",
      url: "",
    },
    components: [],
    timeline: Object.fromEntries(timelineKeys.map((k) => [k, null])),
    durations: {},
    result: { status: "failed", infra_commit: "", error: null },
  };
  let problem: ActionError | undefined;
  const capture = (error: unknown, phase: string) => {
    problem ??= failure(error, phase);
  };
  try {
    const inputs = parseInputs(report.input);
    record = initialRecord(inputs, env, deps.now());
    await execute(
      inputs,
      record,
      report.input("github-token") || env.GITHUB_TOKEN || "",
      work,
      deps,
    );
  } catch (error) {
    capture(error, "action");
  } finally {
    let tailscaleCleaned = true;
    const tailscale = states.get("tailscale");
    if (tailscale)
      try {
        await cleanupTailscale(tailscale, deps.exec);
      } catch (error) {
        tailscaleCleaned = false;
        capture(error, "tailscale_cleanup");
      }
    // execute() also cleans up normally; this path recovers from command errors and partial setup.
    const builder = states.get("builder");
    if (builder)
      try {
        await deps.exec("docker", ["buildx", "rm", "--force", builder], {
          phase: "builder_cleanup",
          timeoutMs: 60000,
        });
        state("builder", "");
      } catch (error) {
        capture(error, "builder_cleanup");
      }
    if (tailscaleCleaned) {
      await rm(work, { recursive: true, force: true });
      state("work", "");
      state("tailscale", "");
    }
  }
  if (problem) {
    record.result.status =
      problem.code === "superseded" || record.result.status === "superseded"
        ? "superseded"
        : "failed";
    record.result.error = problem.toJSON();
  }
  record.durations = durations(record.timeline);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  try {
    await report.artifact(recordPath, directory);
  } catch {
    capture(
      new ActionError(
        "artifact_upload_failed",
        "artifact",
        "Could not upload app-release-record artifact",
      ),
      "artifact",
    );
    record.result.status =
      record.result.status === "superseded" ? "superseded" : "failed";
    record.result.error = problem!.toJSON();
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  for (const [key, value] of Object.entries({
    version: record.version,
    "release-id": record.release_id,
    status: record.result.status,
    "infra-commit": record.result.infra_commit,
    digests: JSON.stringify(
      Object.fromEntries(
        record.components
          .filter((c) => c.digest)
          .map((c) => [c.name, c.digest]),
      ),
    ),
    record: recordPath,
  }))
    report.output(key, value);
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(env.GITHUB_STEP_SUMMARY, summary(record));
  if (problem)
    report.log(`${problem.code} during ${problem.phase}: ${problem.message}`);
  if (problem)
    report.failed(
      `${problem.code} during ${problem.phase}: ${problem.message}`,
    );
}
