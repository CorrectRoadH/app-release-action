import * as core from "@actions/core";
import { runAction } from "./runner.js";
runAction().catch(() =>
  core.setFailed(
    "action_failed during reporting: Could not finalize release record",
  ),
);
