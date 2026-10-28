import type { Snapshot, WaitingThread } from "./state";

/**
 * Decides when a waiting thread is worth a message. The watcher owns timing because the
 * assistant only wakes on events and cannot keep a precise clock.
 *
 * One "episode" is one thread waiting in one way (same run, same status, same requests).
 * Each episode gets at most one notice and one reminder, and notices go out in batches with a
 * minimum gap and a daily cap.
 */

export interface PolicyConfig {
  answerAfterMin: number;
  finishedAfterMin: number;
  reminderAfterMin: number;
  minGapMin: number;
  dailyCap: number;
  /** Never send a first notice for something that started waiting longer ago than this. */
  maxFirstNoticeAgeMin: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  answerAfterMin: 10,
  finishedAfterMin: 30,
  reminderAfterMin: 180,
  minGapMin: 20,
  dailyCap: 12,
  maxFirstNoticeAgeMin: 720,
};

export interface EpisodeState {
  notices: number;
  lastNoticeAt: string;
}

export interface WatchState {
  episodes: Record<string, EpisodeState>;
  /** Send times in the last 24 hours. */
  sends: string[];
}

export const EMPTY_STATE: WatchState = { episodes: {}, sends: [] };

export interface Notice {
  item: WaitingThread;
  notice: "first" | "reminder";
}

export interface Plan {
  notices: Notice[];
  held: "paused" | "gap" | "daily_cap" | null;
  /** Waiting threads you were already told about, not repeated in this batch. */
  alsoWaiting: number;
}

const MINUTE = 60_000;

export function episodeKey(item: WaitingThread): string {
  return [item.threadId, item.runId, item.status, ...item.pendingRequestIds].join("|");
}

export function isNotifiable(item: WaitingThread): boolean {
  return item.unread;
}

export function planNotices(
  snapshot: Snapshot,
  state: WatchState,
  now: Date,
  config: PolicyConfig,
  pausedUntil: Date | null = null,
): Plan {
  const nowMs = now.getTime();
  const due: Notice[] = [];
  let alreadyTold = 0;

  for (const item of snapshot.items) {
    if (!isNotifiable(item)) continue;
    const episode = state.episodes[episodeKey(item)];
    const waitedMin = (nowMs - Date.parse(item.waitingSince)) / MINUTE;
    if (!episode) {
      const threshold = item.status === "finished" || item.status === "failed" ? config.finishedAfterMin : config.answerAfterMin;
      if (waitedMin >= threshold && waitedMin <= config.maxFirstNoticeAgeMin) due.push({ item, notice: "first" });
      continue;
    }
    alreadyTold += 1;
    const sinceLastMin = (nowMs - Date.parse(episode.lastNoticeAt)) / MINUTE;
    if (episode.notices === 1 && sinceLastMin >= config.reminderAfterMin) due.push({ item, notice: "reminder" });
  }

  const alsoWaiting = alreadyTold - due.filter((notice) => notice.notice === "reminder").length;
  if (due.length === 0) return { notices: [], held: null, alsoWaiting };
  if (pausedUntil && pausedUntil.getTime() > nowMs) return { notices: [], held: "paused", alsoWaiting };

  const recent = state.sends.filter((sentAt) => nowMs - Date.parse(sentAt) < 24 * 60 * MINUTE);
  if (recent.length >= config.dailyCap) return { notices: [], held: "daily_cap", alsoWaiting };
  const last = recent.reduce((max, sentAt) => Math.max(max, Date.parse(sentAt)), 0);
  if (nowMs - last < config.minGapMin * MINUTE) return { notices: [], held: "gap", alsoWaiting };

  return { notices: due, held: null, alsoWaiting };
}

export function recordSent(state: WatchState, notices: Notice[], now: Date): WatchState {
  const episodes = { ...state.episodes };
  for (const { item } of notices) {
    const key = episodeKey(item);
    episodes[key] = { notices: (episodes[key]?.notices ?? 0) + 1, lastNoticeAt: now.toISOString() };
  }
  return { episodes, sends: [...state.sends, now.toISOString()] };
}

/** Forget episodes that stopped waiting and sends older than a day. */
export function prune(state: WatchState, snapshot: Snapshot, now: Date): WatchState {
  const live = new Set(snapshot.items.filter(isNotifiable).map(episodeKey));
  const episodes = Object.fromEntries(Object.entries(state.episodes).filter(([key]) => live.has(key)));
  const sends = state.sends.filter((sentAt) => now.getTime() - Date.parse(sentAt) < 24 * 60 * MINUTE);
  return { episodes, sends };
}
