import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { assertSchema, classifyThreads, SchemaMismatchError, type PendingRequestRow, type ThreadRow } from "../src/t3/state";

const NOW = new Date("2026-10-28T12:00:00.000Z");

function thread(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    threadId: "t1",
    projectId: "p1",
    project: "proj",
    title: "Thread",
    runtimeMode: "full-access",
    lastVisitedAt: "2026-10-28T10:00:00.000Z",
    settledOverride: null,
    snoozedUntil: null,
    runId: "run:t1:2",
    runStatus: "completed",
    runRequestedAt: "2026-10-28T10:30:00.000Z",
    runCompletedAt: "2026-10-28T11:00:00.000Z",
    ...overrides,
  };
}

function request(overrides: Partial<PendingRequestRow> = {}): PendingRequestRow {
  return { id: "r1", threadId: "t1", kind: "user_input", createdAt: "2026-10-28T10:45:00.000Z", ...overrides };
}

describe("classifyThreads", () => {
  test("a run that ended after your last visit is unread; one you opened since is read", () => {
    const [unread] = classifyThreads([thread()], [], NOW, 7);
    expect(unread).toMatchObject({ status: "finished", unread: true, waitingSince: "2026-10-28T11:00:00.000Z" });
    const [read] = classifyThreads([thread({ lastVisitedAt: "2026-10-28T11:05:00.000Z" })], [], NOW, 7);
    expect(read).toMatchObject({ status: "finished", unread: false });
  });

  test("a live question outranks the run status and counts as waiting", () => {
    const [item] = classifyThreads([thread({ runStatus: "running", runCompletedAt: null })], [request()], NOW, 7);
    expect(item).toMatchObject({ status: "needs_answer", pendingRequestIds: ["r1"], unread: true });
  });

  test("a pending request left over from an earlier run is ignored", () => {
    const stale = request({ createdAt: "2026-10-14T21:00:00.000Z" });
    expect(classifyThreads([thread()], [stale], NOW, 7)[0]?.status).toBe("finished");
  });

  test("command approvals are flagged separately from questions", () => {
    const [item] = classifyThreads([thread({ runStatus: "waiting", runCompletedAt: null })], [request({ kind: "command" })], NOW, 7);
    expect(item?.status).toBe("needs_approval");
  });

  test("settled, snoozed, still-running and out-of-window threads are not waiting", () => {
    expect(classifyThreads([thread({ settledOverride: "settled" })], [], NOW, 7)).toEqual([]);
    expect(classifyThreads([thread({ snoozedUntil: "2026-10-29T09:00:00.000Z" })], [], NOW, 7)).toEqual([]);
    expect(classifyThreads([thread({ runStatus: "running", runCompletedAt: null })], [], NOW, 7)).toEqual([]);
    expect(classifyThreads([thread({ runCompletedAt: "2026-10-01T00:00:00.000Z" })], [], NOW, 7)).toEqual([]);
  });

  test("an expired snooze no longer hides the thread", () => {
    expect(classifyThreads([thread({ snoozedUntil: "2026-10-28T09:00:00.000Z" })], [], NOW, 7)).toHaveLength(1);
  });
});

describe("assertSchema", () => {
  test("fails loudly when a T3 update drops a column the watcher reads", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads (thread_id, project_id, title, runtime_mode, updated_at, archived_at, deleted_at, payload_json);
      CREATE TABLE orchestration_v2_projection_runs (run_id, thread_id, ordinal, status, requested_at);
      CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, kind, status, created_at);
      CREATE TABLE orchestration_v2_projection_messages (thread_id, role, streaming, created_at, payload_json);
      CREATE TABLE projection_projects (project_id, title);
    `);
    expect(() => assertSchema(db)).toThrow(SchemaMismatchError);
    expect(() => assertSchema(db)).toThrow(/completed_at/);
  });
});
