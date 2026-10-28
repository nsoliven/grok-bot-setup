import { describe, expect, test } from "bun:test";
import { buildNeedsYouPayload } from "../src/t3/payload";
import { DEFAULT_POLICY, EMPTY_STATE, planNotices, prune, recordSent, type WatchState } from "../src/t3/policy";
import type { Snapshot, WaitingThread } from "../src/t3/state";

const minutes = (n: number) => n * 60_000;
const T0 = Date.parse("2026-10-28T12:00:00.000Z");

function item(overrides: Partial<WaitingThread> = {}): WaitingThread {
  return {
    threadId: "t1",
    projectId: "p1",
    project: "proj",
    title: "Secret-ish title",
    status: "finished",
    waitingSince: new Date(T0).toISOString(),
    runId: "run:t1:1",
    runtimeMode: "full-access",
    pendingRequestIds: [],
    unread: true,
    ...overrides,
  };
}

const snap = (...items: WaitingThread[]): Snapshot => ({ takenAt: "", lastSeenInT3At: null, items });
const at = (offsetMin: number) => new Date(T0 + minutes(offsetMin));

describe("planNotices", () => {
  test("waits out the threshold: 10 minutes for a question, 30 for a finished run", () => {
    const question = item({ threadId: "q", status: "needs_answer", pendingRequestIds: ["r"] });
    const finished = item({ threadId: "f" });
    expect(planNotices(snap(question, finished), EMPTY_STATE, at(9), DEFAULT_POLICY).notices).toHaveLength(0);
    expect(planNotices(snap(question, finished), EMPTY_STATE, at(10), DEFAULT_POLICY).notices.map((n) => n.item.threadId)).toEqual(["q"]);
    expect(planNotices(snap(question, finished), EMPTY_STATE, at(30), DEFAULT_POLICY).notices).toHaveLength(2);
  });

  test("never alerts for a thread you already opened", () => {
    expect(planNotices(snap(item({ unread: false })), EMPTY_STATE, at(120), DEFAULT_POLICY).notices).toHaveLength(0);
  });

  test("one notice, one reminder after 3 hours, then silence", () => {
    const waiting = snap(item());
    let state: WatchState = recordSent(EMPTY_STATE, planNotices(waiting, EMPTY_STATE, at(30), DEFAULT_POLICY).notices, at(30));
    expect(planNotices(waiting, state, at(60), DEFAULT_POLICY)).toMatchObject({ notices: [], alsoWaiting: 1 });
    const reminder = planNotices(waiting, state, at(30 + 180), DEFAULT_POLICY);
    expect(reminder.notices.map((n) => n.notice)).toEqual(["reminder"]);
    state = recordSent(state, reminder.notices, at(210));
    expect(planNotices(waiting, state, at(2000), DEFAULT_POLICY).notices).toHaveLength(0);
  });

  test("batches respect the minimum gap and the daily cap", () => {
    const justSent: WatchState = { episodes: {}, sends: [at(25).toISOString()] };
    expect(planNotices(snap(item()), justSent, at(30), DEFAULT_POLICY).held).toBe("gap");
    expect(planNotices(snap(item()), justSent, at(45), DEFAULT_POLICY).notices).toHaveLength(1);
    const capped: WatchState = { episodes: {}, sends: Array.from({ length: 12 }, (_, i) => at(-600 + i * 30).toISOString()) };
    expect(planNotices(snap(item()), capped, at(30), DEFAULT_POLICY).held).toBe("daily_cap");
  });

  test("does not dig up old backlog when the watcher starts", () => {
    expect(planNotices(snap(item()), EMPTY_STATE, at(13 * 60), DEFAULT_POLICY).notices).toHaveLength(0);
  });

  test("a pause holds alerts until it ends", () => {
    expect(planNotices(snap(item()), EMPTY_STATE, at(30), DEFAULT_POLICY, at(90)).held).toBe("paused");
    expect(planNotices(snap(item()), EMPTY_STATE, at(91), DEFAULT_POLICY, at(90)).notices).toHaveLength(1);
  });

  test("a new run in the same thread is a new episode", () => {
    const first = snap(item());
    const state = prune(recordSent(EMPTY_STATE, planNotices(first, EMPTY_STATE, at(30), DEFAULT_POLICY).notices, at(30)), first, at(30));
    const next = snap(item({ runId: "run:t1:2", waitingSince: at(60).toISOString() }));
    expect(planNotices(next, prune(state, next, at(100)), at(100), DEFAULT_POLICY).notices.map((n) => n.notice)).toEqual(["first"]);
  });
});

describe("payload", () => {
  test("carries metadata only, and drops titles when asked", () => {
    const payload = buildNeedsYouPayload([{ item: item(), notice: "first" }], 2, null, at(45), {
      includeTitles: false,
      linkBase: null,
      host: "my-server",
    });
    expect(payload.items[0]).toMatchObject({ title: null, project: null, minutesWaiting: 45, answerableFromChat: true });
    expect(JSON.stringify(payload)).not.toContain("Secret-ish");
  });
});
