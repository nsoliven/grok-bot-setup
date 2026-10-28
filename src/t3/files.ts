import { join } from "node:path";
import { paths, readJsonFile } from "../lib/config";

/** Non-secret state shared by the watcher, gateway and CLI. Secrets live in the secrets dir. */
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
  get credentialMeta() {
    return join(paths.stateDir, "t3-mcp-credential.json");
  },
  get gatewayAudit() {
    return join(paths.stateDir, "t3-gateway-audit.jsonl");
  },
};

export interface CredentialMeta {
  expiresAt: string;
  access: string;
  pairedAt: string;
}

export function readPausedUntil(): Date | null {
  const paused = readJsonFile<{ until: string }>(files.pausedUntil);
  return paused ? new Date(paused.until) : null;
}
