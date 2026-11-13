import { DefaultArtifactClient } from "@actions/artifact";
// Run the SDK in an isolated process: even its debug/error logging cannot echo
// artifact service credentials or signed upload URLs into the workflow log.
const [path, root] = process.argv.slice(2);
if (!path || !root) process.exitCode = 1;
else
  new DefaultArtifactClient()
    .uploadArtifact("app-release-record", [path], root, { retentionDays: 14 })
    .catch(() => {
      process.exitCode = 1;
    });
