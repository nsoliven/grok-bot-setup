import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const env = process.env;

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function numberSetting(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

export function stringSetting(name: string, fallback: string): string;
export function stringSetting(name: string): string | undefined;
export function stringSetting(name: string, fallback?: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : fallback;
}

export function flagSetting(name: string, fallback = false): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

export const paths = {
  configDir: expandHome(stringSetting("GBS_CONFIG_DIR", "~/.config/grok-bot-setup")),
  get secretsDir() {
    return expandHome(stringSetting("GBS_SECRETS_DIR", join(this.configDir, "secrets")));
  },
  // systemd sets STATE_DIRECTORY from the units' StateDirectory=.
  stateDir: expandHome(stringSetting("STATE_DIRECTORY") ?? stringSetting("GBS_STATE_DIR", "~/.local/state/grok-bot-setup")),
  t3StateDb: expandHome(stringSetting("T3_STATE_DB", "~/.t3/userdata/statev2.sqlite")),
  t3Home: expandHome(stringSetting("T3_HOME", "~/.t3")),
};

function assertPrivate(path: string, kind: "file" | "directory"): void {
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users. Run: chmod ${kind === "file" ? "600" : "700"} ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${path} is not owned by the current user.`);
  }
}

/** Reads one secret file. Refuses files other users could read. Never log the return value. */
export function readSecret(name: string): string {
  assertPrivate(paths.secretsDir, "directory");
  const file = join(paths.secretsDir, name);
  assertPrivate(file, "file");
  const value = readFileSync(file, "utf8").trim();
  if (!value) throw new Error(`${file} is empty.`);
  return value;
}

export function writeSecret(name: string, value: string): void {
  mkdirSync(paths.secretsDir, { recursive: true, mode: 0o700 });
  assertPrivate(paths.secretsDir, "directory");
  writePrivateFile(join(paths.secretsDir, name), `${value}\n`);
}

/**
 * Atomic write with 0600, so a crash never leaves a half-written state or secret file.
 * The temp file is created exclusively ("wx") under a random name, so a planted symlink cannot redirect it.
 */
export function writePrivateFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/** Creates a 0700 directory, or refuses an existing one other users can read. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPrivate(path, "directory");
}

export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
