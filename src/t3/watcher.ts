import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { flagSetting, numberSetting, paths, readJsonFile, stringSetting, writePrivateFile } from "../lib/config";
import { postToAssistant } from "../lib/webhook";
import { files, readPausedUntil } from "./files";
import { buildMaintenancePayload, buildNeedsYouPayload, type PayloadOptions } from "./payload";
import { DEFAULT_POLICY, EMPTY_STATE, planNotices, prune, recordSent, type PolicyConfig, type WatchState } from "./policy";
import { openT3State, readSnapshot, SchemaMismatchError } from "./state";

/**
 * The watcher: polls T3's state database read-only and wakes the assistant only when
 * something has clearly been left waiting. It has no listener and no T3 credential.
 */

export interface WatchSettings {
  pollSeconds: number;
  windowDays: number;
  policy: PolicyConfig;
  payload: PayloadOptions;
}

export function loadWatchSettings(): WatchSettings {
  return {
    pollSeconds: Math.max(10, numberSetting("WATCH_POLL_SECONDS", 30)),
    windowDays: numberSetting("WATCH_WINDOW_DAYS", 7),
    policy: {
      answerAfterMin: numberSetting("NOTIFY_ANSWER_AFTER_MIN", DEFAULT_POLICY.answerAfterMin),
      finishedAfterMin: numberSetting("NOTIFY_FINISHED_AFTER_MIN", DEFAULT_POLICY.finishedAfterMin),
      reminderAfterMin: numberSetting("NOTIFY_REMINDER_AFTER_MIN", DEFAULT_POLICY.reminderAfterMin),
      minGapMin: numberSetting("NOTIFY_MIN_GAP_MIN", DEFAULT_POLICY.minGapMin),
      dailyCap: numberSetting("NOTIFY_DAILY_CAP", DEFAULT_POLICY.dailyCap),
      maxFirstNoticeAgeMin: numberSetting("NOTIFY_MAX_FIRST_NOTICE_AGE_MIN", DEFAULT_POLICY.maxFirstNoticeAgeMin),
    },
    payload: {
      includeTitles: flagSetting("PAYLOAD_INCLUDE_TITLES", true),
      linkBase: stringSetting("PAYLOAD_LINK_BASE") ?? null,
      host: stringSetting("HOST_LABEL", hostname()),
    },
  };
}

interface MaintenanceState {
  lastProblemAt?: string;
}

const DAY = 86_400_000;

async function sendMaintenance(
  key: keyof MaintenanceState,
  event: Parameters<typeof buildMaintenancePayload>[0],
  detail: string,
  now: Date,
  settings: WatchSettings,
): Promise<void> {
  const state = readJsonFile<MaintenanceState>(files.maintenance) ?? {};
  const last = state[key];
  if (last && now.getTime() - Date.parse(last) < DAY) return;
  const result = await postToAssistant(buildMaintenancePayload(event, detail, now, settings.payload.host));
  if (result.ok) writePrivateFile(files.maintenance, JSON.stringify({ ...state, [key]: now.toISOString() }));
  console.log(`maintenance ${event}: ${result.ok ? "sent" : result.reason}`);
}

export async function tick(db: Database, settings: WatchSettings, now = new Date()): Promise<string> {
  const snapshot = readSnapshot(db, now, settings.windowDays);
  let state = prune(readJsonFile<WatchState>(files.watchState) ?? EMPTY_STATE, snapshot, now);
  const plan = planNotices(snapshot, state, now, settings.policy, readPausedUntil());
  let outcome = plan.held ? `held:${plan.held}` : "idle";
  if (plan.notices.length > 0) {
    const payload = buildNeedsYouPayload(plan.notices, plan.alsoWaiting, snapshot.lastSeenInT3At, now, settings.payload);
    const result = await postToAssistant(payload);
    if (result.ok) {
      state = recordSent(state, plan.notices, now);
      outcome = `sent ${plan.notices.length} (${plan.notices.map((notice) => `${notice.item.threadId}:${notice.notice}`).join(", ")})`;
    } else {
      outcome = `send failed: ${result.reason}`;
    }
  }
  writePrivateFile(files.watchState, JSON.stringify(state));
  return outcome;
}

async function main(): Promise<void> {
  const settings = loadWatchSettings();
  console.log(`watching ${paths.t3StateDb} every ${settings.pollSeconds}s`);
  let db: Database | null = null;
  let failures = 0;
  let lastOutcome = "";
  for (;;) {
    try {
      db ??= openT3State(paths.t3StateDb);
      const outcome = await tick(db, settings);
      failures = outcome.startsWith("send failed") ? failures + 1 : 0;
      if (outcome !== lastOutcome) console.log(outcome);
      lastOutcome = outcome;
    } catch (error) {
      failures += 1;
      db?.close();
      db = null;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`tick failed: ${message}`);
      const detail =
        error instanceof SchemaMismatchError
          ? `T3 changed its state database after an update, so alerts are off until grok-bot-setup is updated. (${message})`
          : `The watcher cannot read T3 state: ${message}`;
      await sendMaintenance("lastProblemAt", "t3.watcher_problem", detail, new Date(), settings).catch(() => {});
    }
    // Back off on repeated failures, up to 10 minutes, so a dead webhook is not hammered.
    const delay = Math.min(settings.pollSeconds * 2 ** Math.min(failures, 5), 600);
    await Bun.sleep(delay * 1000);
  }
}

if (import.meta.main) await main();
