import { join } from "node:path";
import { paths, readJsonFile } from "../lib/config";

/** Non-secret state shared by the watcher and CLI. Secrets live in the secrets dir. */
export const files = {
  get watchState() {
    return join(paths.stateDir, "t3-watch.json");
  },
  get pausedUntil() {
    return join(paths.stateDir, "t3-paused-until.json");
  },
  get maintenance() {
    return join(paths.stateDir, "t3-maintenance.json");
  },
};

export function readPausedUntil(): Date | null {
  const paused = readJsonFile<{ until: string }>(files.pausedUntil);
  return paused ? new Date(paused.until) : null;
}
