import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  at: string;
  tool: string;
  threadId: string;
  requestId?: string;
  ok: boolean;
  /** Size and hash of what was sent, so the log proves what happened without copying content. */
  chars?: number;
  sha256?: string;
  error?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
  /** Attempts, not just successes, so a loop of refused sends still runs into the cap. */
  writesInLastDay(now: Date): number;
}

/** Append-only JSONL audit of every write the gateway attempts. */
export function fileAuditLog(path: string): AuditLog {
  return {
    record(entry) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fresh = !existsSync(path);
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      if (fresh) chmodSync(path, 0o600);
    },
    writesInLastDay(now) {
      if (!existsSync(path)) return 0;
      const cutoff = now.getTime() - 86_400_000;
      return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEntry)
        .filter((entry) => Date.parse(entry.at) >= cutoff).length;
    },
  };
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}
