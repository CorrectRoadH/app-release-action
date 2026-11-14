import { DefaultArtifactClient } from "@actions/artifact";
import { writeFileSync } from "node:fs";
// Run the SDK in an isolated process: even its debug/error logging cannot echo
// artifact service credentials or signed upload URLs into the workflow log.
const [path, root] = process.argv.slice(2);
if (!path || !root) process.exitCode = 1;
else
  new DefaultArtifactClient()
    .uploadArtifact("app-release-record", [path], root, { retentionDays: 14 })
    .catch((error: unknown) => {
      // Quota exhaustion is permanent until GitHub recalculates storage. Report
      // only a fixed marker; SDK errors can contain signed URLs or credentials.
      if (
        error instanceof Error &&
        error.message.includes("Artifact storage quota has been hit")
      ) writeFileSync(`${path}.quota-exceeded`, "artifact_quota_exceeded\n");
      else process.exitCode = 1;
    });
