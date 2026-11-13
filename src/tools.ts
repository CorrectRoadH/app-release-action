import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ActionError } from "./model.js";
import { type Fetch } from "./http.js";
import { type Run } from "./process.js";
export const regctlVersion = "v0.11.7";
export const regctlChecksums: Record<string, string> = {
  x64: "3737fbbdd791e04e7a831640b681f3397a376498e80e2ad9b1b2d27296f239bc",
  arm64: "9f349bab5c407ac04f3dabf99c7c7a6b0f9e9723c23f2775380e804d02c6dbb9",
};
export const tailscaleActionCommit = "064b10558093f38325e838ddea35486bdc6b1d5c"; // v4.4.0
export const tailscaleArchiveSha256 =
  "0e442c29a59fc36051cce5e489eb8f748fdacb4995102ea4d4b4faf0e650d3e4";
export function verify(bytes: Uint8Array, expected: string): void {
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new ActionError(
      "checksum_mismatch",
      "setup",
      "Tool SHA-256 mismatch",
    );
}
async function download(
  url: string,
  path: string,
  checksum: string,
  fetcher: Fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new ActionError("download_failed", "setup", "Tool download failed");
  }
  if (!response.ok)
    throw new ActionError("download_failed", "setup", "Tool download failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  verify(bytes, checksum);
  await writeFile(path, bytes, { mode: 0o700 });
}
export async function installRegctl(
  directory: string,
  arch: string,
  fetcher: Fetch,
): Promise<string> {
  const checksum = regctlChecksums[arch];
  if (!checksum)
    throw new ActionError(
      "unsupported_runner",
      "setup",
      "Only Linux x64 and arm64 runners are supported",
    );
  await mkdir(directory, { recursive: true });
  const path = join(directory, "regctl");
  await download(
    `https://github.com/regclient/regclient/releases/download/${regctlVersion}/regctl-linux-${arch === "x64" ? "amd64" : "arm64"}`,
    path,
    checksum,
    fetcher,
  );
  await chmod(path, 0o700);
  return path;
}
export async function prepareTailscale(
  directory: string,
  exec: Run,
  fetcher: Fetch,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const archive = join(directory, "action.tgz");
  await download(
    `https://codeload.github.com/tailscale/github-action/tar.gz/${tailscaleActionCommit}`,
    archive,
    tailscaleArchiveSha256,
    fetcher,
  );
  await exec("tar", ["xzf", archive, "--strip-components=1", "-C", directory], {
    phase: "tailscale",
  });
  // Verify these are the JavaScript entrypoints declared by the pinned official action.
  const metadata = await readFile(join(directory, "action.yml"), "utf8");
  if (
    !metadata.includes("main: 'dist/index.js'") ||
    !metadata.includes("post: 'dist/logout/index.js'")
  )
    throw new ActionError(
      "invalid_tool",
      "tailscale",
      "Unexpected official Tailscale action entrypoints",
    );
  return directory;
}
