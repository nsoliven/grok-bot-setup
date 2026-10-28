import { existsSync, rmSync } from "node:fs";
import { paths, readJsonFile, writePrivateFile } from "./lib/config";
import { postToAssistant } from "./lib/webhook";
import { files, readPausedUntil } from "./t3/files";
import { buildMaintenancePayload, buildNeedsYouPayload } from "./t3/payload";
import { EMPTY_STATE, episodeKey, isNotifiable, type WatchState } from "./t3/policy";
import { openT3State, readSnapshot } from "./t3/state";
import { loadWatchSettings } from "./t3/watcher";

const USAGE = `grok-t3 <command>

  status               What is waiting, what was sent, and whether alerts are paused
  preview              Print the webhook body the watcher would send for everything waiting now
  pause <30m|2h|1d>    Stop alerts for a while (answering from chat keeps working)
  resume               End a pause
  test-webhook         Send a t3.test event to the assistant
`;

function parseDuration(text: string | undefined): number {
  const match = /^(\d+)(m|h|d)$/.exec(text ?? "");
  if (!match) throw new Error("Use a duration like 30m, 2h or 1d.");
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
}

function minutesAgo(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  return minutes < 120 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

async function status(): Promise<void> {
  const settings = loadWatchSettings();
  const now = new Date();
  const snapshot = readSnapshot(openT3State(paths.t3StateDb), now, settings.windowDays);
  const state = readJsonFile<WatchState>(files.watchState) ?? EMPTY_STATE;
  console.log(`Waiting on you (${snapshot.items.length}), last seen in T3 ${snapshot.lastSeenInT3At ? `${minutesAgo(snapshot.lastSeenInT3At, now)} ago` : "never"}:`);
  for (const item of snapshot.items) {
    const told = state.episodes[episodeKey(item)]?.notices ?? 0;
    const flag = isNotifiable(item) ? (told ? `told x${told}` : "not yet told") : "read, no alert";
    console.log(`  ${item.status.padEnd(14)} ${minutesAgo(item.waitingSince, now).padStart(7)}  ${flag.padEnd(14)} ${item.title}  [${item.threadId}]`);
  }
  const sends = state.sends.filter((sentAt) => now.getTime() - Date.parse(sentAt) < 86_400_000);
  console.log(`\nAlerts in the last 24h: ${sends.length}/${settings.policy.dailyCap}${sends.length ? ` (last ${minutesAgo(sends.at(-1)!, now)} ago)` : ""}`);
  const paused = readPausedUntil();
  console.log(`Paused: ${paused && paused > now ? `until ${paused.toLocaleString()}` : "no"}`);
}

async function preview(): Promise<void> {
  const settings = loadWatchSettings();
  const now = new Date();
  const snapshot = readSnapshot(openT3State(paths.t3StateDb), now, settings.windowDays);
  const notices = snapshot.items.filter(isNotifiable).map((item) => ({ item, notice: "first" as const }));
  console.log(JSON.stringify(buildNeedsYouPayload(notices, 0, snapshot.lastSeenInT3At, now, settings.payload), null, 2));
}

async function main(argv: string[]): Promise<void> {
  const [command, arg] = argv;
  switch (command) {
    case "status":
      return status();
    case "preview":
      return preview();
    case "pause": {
      const until = new Date(Date.now() + parseDuration(arg));
      writePrivateFile(files.pausedUntil, JSON.stringify({ until: until.toISOString() }));
      console.log(`Alerts paused until ${until.toLocaleString()}.`);
      return;
    }
    case "resume":
      if (existsSync(files.pausedUntil)) rmSync(files.pausedUntil);
      console.log("Alerts resumed.");
      return;
    case "test-webhook": {
      const settings = loadWatchSettings();
      const result = await postToAssistant(
        buildMaintenancePayload("t3.test", "Test from grok-bot-setup. No action needed.", new Date(), settings.payload.host),
      );
      console.log(result.ok ? `Delivered (HTTP ${result.status}).` : `Failed: ${result.reason}`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    default:
      console.log(USAGE);
      if (command && command !== "help") process.exitCode = 1;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
