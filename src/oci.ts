import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ActionError } from "./model.js";
export interface Descriptor {
  digest: string;
  size: number;
  mediaType?: string;
  platform?: { os: string; architecture: string; variant?: string };
}
export interface Manifest {
  config: Descriptor;
  layers: Descriptor[];
}
export function validateDescriptor(d: Descriptor): void {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(d?.digest) ||
    !Number.isSafeInteger(d.size) ||
    d.size < 0
  )
    throw new ActionError(
      "invalid_manifest",
      "image",
      "Invalid OCI descriptor",
    );
}
export async function readManifest(
  directory: string,
  platform: string,
): Promise<Manifest> {
  const [os, architecture, variant] = platform.split("/");
  const read = async (d: Descriptor): Promise<unknown> => {
    validateDescriptor(d);
    const blob = await readFile(
      join(directory, "blobs", "sha256", d.digest.slice(7)),
    );
    if (
      blob.length !== d.size ||
      createHash("sha256").update(blob).digest("hex") !== d.digest.slice(7)
    )
      throw new ActionError(
        "invalid_manifest",
        "image",
        "OCI blob checksum mismatch",
      );
    return JSON.parse(blob.toString());
  };
  const descend = async (value: unknown, depth: number): Promise<Manifest> => {
    if (depth > 5)
      throw new ActionError(
        "invalid_manifest",
        "image",
        "OCI index is too deeply nested",
      );
    const object = value as {
      manifests?: Descriptor[];
      config?: Descriptor;
      layers?: Descriptor[];
    };
    if (object.manifests) {
      const match =
        object.manifests.find(
          (d) =>
            d.platform?.os === os &&
            d.platform.architecture === architecture &&
            (!variant || d.platform.variant === variant),
        ) ?? object.manifests.find((d) => !d.platform);
      if (!match)
        throw new ActionError(
          "platform_mismatch",
          "image",
          "OCI output does not contain the requested platform",
        );
      return descend(await read(match), depth + 1);
    }
    if (!object.config || !Array.isArray(object.layers))
      throw new ActionError(
        "invalid_manifest",
        "image",
        "Invalid OCI manifest",
      );
    validateDescriptor(object.config);
    object.layers.forEach(validateDescriptor);
    return { config: object.config, layers: object.layers };
  };
  return descend(
    JSON.parse(await readFile(join(directory, "index.json"), "utf8")),
    0,
  );
}
export function cacheStats(raw: string): {
  cache_hit_steps: number;
  cache_miss_steps: number;
} {
  const steps = new Map<string, boolean>();
  for (const line of raw.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as {
        vertexes?: {
          digest?: string;
          completed?: string;
          cached?: boolean;
          error?: unknown;
        }[];
      };
      for (const vertex of event.vertexes ?? []) {
        if (vertex.digest && vertex.completed && !vertex.error)
          steps.set(vertex.digest, vertex.cached === true);
      }
    } catch {
      /* Buildx can interleave non-JSON diagnostics. */
    }
  }
  return {
    cache_hit_steps: [...steps.values()].filter(Boolean).length,
    cache_miss_steps: [...steps.values()].filter((v) => !v).length,
  };
}
export async function classifyLayers(
  layers: Descriptor[],
  exists: (digest: string) => Promise<boolean>,
): Promise<{
  layers: number;
  layers_reused: number;
  image_bytes: number;
  pushed_bytes: number;
}> {
  let layers_reused = 0,
    image_bytes = 0,
    pushed_bytes = 0;
  const uploaded = new Set<string>();
  for (const layer of layers) {
    validateDescriptor(layer);
    image_bytes += layer.size;
    if (await exists(layer.digest)) layers_reused++;
    else if (!uploaded.has(layer.digest)) {
      pushed_bytes += layer.size;
      uploaded.add(layer.digest);
    }
  }
  return { layers: layers.length, layers_reused, image_bytes, pushed_bytes };
}
