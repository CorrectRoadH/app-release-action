import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type Inputs, imageName } from "./inputs.js";
import {
  type ReleaseRecord,
  ActionError,
  durations,
  failure,
} from "./model.js";
import { type Run } from "./process.js";
import { type Fetch, oidc } from "./http.js";
import { readManifest, cacheStats, classifyLayers } from "./oci.js";
import { Registry } from "./registry.js";
import { deploy } from "./client.js";
import { installRegctl, prepareTailscale } from "./tools.js";
import { connectTailscale, existingTailscale } from "./tailscale.js";
import { metadata } from "./github.js";

export const UPSTREAM_REVISION_LABEL =
  "io.github.correctroadh.app-release-action.upstream-revision";
export interface Dependencies {
  exec: Run;
  fetch: Fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  state: (key: string, value: string) => void;
  log: (message: string) => void;
  existingTailscale: typeof existingTailscale;
  installRegctl: typeof installRegctl;
  prepareTailscale: typeof prepareTailscale;
}
export async function execute(
  inputs: Inputs,
  record: ReleaseRecord,
  token: string,
  directory: string,
  deps: Dependencies,
): Promise<void> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new ActionError(
      "unsupported_runner",
      "setup",
      "Linux x64 or arm64 runners are required",
    );
  if (!token)
    throw new ActionError("missing_token", "setup", "github-token is required");
  const tools = join(directory, "tools");
  const regctl = await deps.installRegctl(tools, process.arch, deps.fetch);
  try {
    await metadata(record, token, process.env, deps.fetch);
  } catch (error) {
    throw failure(error, "metadata");
  }
  const builder = `app-release-${randomUUID()}`;
  deps.state("builder", builder);
  try {
    await deps.exec(
      "docker",
      ["buildx", "create", "--name", builder, "--driver", "docker-container"],
      { phase: "setup" },
    );
    const auth = [
      "--host",
      `reg=ghcr.io,user=${record.source.actor},pass=${token}`,
    ];
    for (const component of inputs.components) {
      const image = imageName(
        inputs.imagePrefix,
        component.name,
        inputs.components.length,
      );
      const registry = new Registry(
        image.slice("ghcr.io/".length),
        record.source.actor,
        token,
        deps.fetch,
      );
      const directoryOCI = join(directory, `oci-${component.name}`);
      const buildStart = deps.now();
      const labels: Record<string, string> = {
        "org.opencontainers.image.revision": record.source.revision,
        "org.opencontainers.image.source": `https://github.com/${record.source.repository}`,
        "org.opencontainers.image.version": record.version,
        "org.opencontainers.image.created": buildStart.toISOString(),
      };
      if (inputs.upstreamRevision)
        labels[UPSTREAM_REVISION_LABEL] = inputs.upstreamRevision;
      record.timeline.build_started ??= buildStart.toISOString();
      let stats = { cache_hit_steps: 0, cache_miss_steps: 0 };
      try {
        deps.log(`Building ${component.name}`);
        const args = [
          "buildx",
          "build",
          "--builder",
          builder,
          "--platform",
          inputs.platform,
          "--file",
          component.dockerfile,
          "--output",
          `type=oci,dest=${directoryOCI},tar=false`,
          "--progress=rawjson",
          "--provenance=false",
          "--cache-from",
          `type=gha,scope=${inputs.app}-${component.name}`,
          "--cache-to",
          `type=gha,mode=max,scope=${inputs.app}-${component.name}`,
          ...Object.entries(labels).flatMap(([k, v]) => [
            "--label",
            `${k}=${v}`,
          ]),
          ...component.buildArgs.flatMap((arg) => ["--build-arg", arg]),
          ...(component.target ? ["--target", component.target] : []),
          component.context,
        ];
        const output = await deps.exec("docker", args, { phase: "build" });
        stats = cacheStats(`${output.stdout}\n${output.stderr}`);
      } catch (error) {
        if (error instanceof ActionError && error.detail)
          deps.log(
            `::group::Build output for ${component.name} (last lines)\n${error.detail}\n::endgroup::`,
          );
        throw failure(error, "build");
      } finally {
        record.timeline.build_finished = deps.now().toISOString();
      }
      const buildSeconds =
        (Date.parse(record.timeline.build_finished) - buildStart.getTime()) /
        1000;
      try {
        const manifest = await readManifest(directoryOCI, inputs.platform);
        const layerStats = await classifyLayers(manifest.layers, (digest) =>
          registry.exists(digest),
        );
        await registry.assertNewTag(record.version);
        const c = {
          name: component.name,
          image,
          digest: "",
          platform: inputs.platform,
          ...layerStats,
          ...stats,
          build_seconds: buildSeconds,
          push_seconds: 0,
        };
        record.components.push(c);
        const pushStart = deps.now();
        record.timeline.push_started ??= pushStart.toISOString();
        deps.log(`Pushing ${component.name}`);
        try {
          await deps.exec(
            regctl,
            [
              ...auth,
              "image",
              "copy",
              `ocidir://${directoryOCI}`,
              `${image}:${record.version}`,
            ],
            { phase: "push" },
          );
        } finally {
          record.timeline.push_finished = deps.now().toISOString();
          c.push_seconds =
            (Date.parse(record.timeline.push_finished) - pushStart.getTime()) /
            1000;
        }
        const result = await deps.exec(
          regctl,
          [...auth, "image", "digest", `${image}:${record.version}`],
          { phase: "push", timeoutMs: 60000 },
        );
        c.digest = result.stdout.trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(c.digest))
          throw new ActionError(
            "invalid_digest",
            "push",
            "GHCR returned an invalid digest",
          );
        const remote = await registry.manifest(c.digest, inputs.platform);
        if (
          remote.layers.length !== manifest.layers.length ||
          remote.layers.some(
            (l, i) =>
              l.digest !== manifest.layers[i].digest ||
              l.size !== manifest.layers[i].size,
          )
        )
          throw new ActionError(
            "manifest_mismatch",
            "push",
            "Pushed layers differ from the exported image",
          );
        c.image_bytes = remote.layers.reduce((sum, l) => sum + l.size, 0);
        c.layers = remote.layers.length;
      } catch (error) {
        throw failure(error, "push");
      } finally {
        await rm(directoryOCI, { recursive: true, force: true });
      }
    }
  } finally {
    await deps.exec("docker", ["buildx", "rm", "--force", builder], {
      phase: "builder_cleanup",
      timeoutMs: 60000,
    });
    deps.state("builder", "");
  }
  record.durations = durations(record.timeline);
  if (!inputs.deploy) {
    record.result.status = "built";
    return;
  }
  const tailscaleDir = join(directory, "tailscale");
  await mkdir(tailscaleDir, { recursive: true });
  await deps.prepareTailscale(tailscaleDir, deps.exec, deps.fetch);
  deps.state("tailscale", tailscaleDir);
  await connectTailscale(
    tailscaleDir,
    inputs,
    deps.exec,
    deps.existingTailscale,
  );
  await deploy(
    record,
    inputs.deployerUrl,
    inputs.timeoutMs,
    {
      fetch: deps.fetch,
      token: () => oidc("app-deployer", deps.fetch),
      now: () => deps.now().getTime(),
      sleep: deps.sleep,
    },
    (r) => {
      record.release_id = r.release_id;
      Object.assign(record.timeline, r.timeline);
      record.result = {
        status: r.status,
        infra_commit: r.infra_commit,
        error: r.error,
      };
    },
  );
}
