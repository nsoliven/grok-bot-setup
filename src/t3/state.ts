import { Database } from "bun:sqlite";

/**
 * Reads "what is waiting on me" from T3 Code's local state database, read-only.
 *
 * T3 has no public API for read state (`lastVisitedAt`), so this reads its internal
 * projection tables. The rules mirror T3's own `projectThreadAwarenessV2`: subagents never
 * count, settled finished threads never count, and a pending question outranks run status.
 * `assertSchema` fails loudly when a T3 update changes these tables.
 */

export type WaitingStatus = "needs_answer" | "needs_approval" | "finished" | "failed";

export interface WaitingThread {
  threadId: string;
  projectId: string;
  project: string | null;
  title: string;
  status: WaitingStatus;
  /** When the thread started waiting: the oldest pending request, or when the run ended. */
  waitingSince: string;
  runId: string;
  runtimeMode: string;
  pendingRequestIds: string[];
  /** Finished/failed: you have not opened the thread since it ended. Requests: always true until answered. */
  unread: boolean;
}

export interface Snapshot {
  takenAt: string;
  /** Most recent time you opened any thread in T3. */
  lastSeenInT3At: string | null;
  items: WaitingThread[];
}

export interface ThreadRow {
  threadId: string;
  projectId: string;
  project: string | null;
  title: string;
  runtimeMode: string;
  lastVisitedAt: string | null;
  settledOverride: string | null;
  snoozedUntil: string | null;
  runId: string;
  runStatus: string;
  runRequestedAt: string;
  runCompletedAt: string | null;
}

export interface PendingRequestRow {
  id: string;
  threadId: string;
  kind: string;
  createdAt: string;
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  orchestration_v2_projection_threads: [
    "thread_id",
    "project_id",
    "title",
    "runtime_mode",
    "updated_at",
    "archived_at",
    "deleted_at",
    "payload_json",
  ],
  orchestration_v2_projection_runs: ["run_id", "thread_id", "ordinal", "status", "requested_at", "completed_at"],
  orchestration_v2_projection_runtime_requests: ["runtime_request_id", "thread_id", "kind", "status", "created_at"],
  projection_projects: ["project_id", "title"],
};

export class SchemaMismatchError extends Error {
  override name = "SchemaMismatchError";
}

export function openT3State(path: string): Database {
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout = 2000");
  assertSchema(db);
  return db;
}

export function assertSchema(db: Database): void {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(
      db
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
        .all()
        .map((row) => row.name),
    );
    if (present.size === 0) throw new SchemaMismatchError(`T3 state table ${table} is missing.`);
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length > 0) throw new SchemaMismatchError(`T3 state table ${table} lacks ${missing.join(", ")}.`);
  }
}

export function readSnapshot(db: Database, now: Date, windowDays: number): Snapshot {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const threads = db
    .query<ThreadRow, [string]>(
      `SELECT t.thread_id AS threadId,
              t.project_id AS projectId,
              p.title AS project,
              t.title AS title,
              t.runtime_mode AS runtimeMode,
              json_extract(t.payload_json, '$.lastVisitedAt') AS lastVisitedAt,
              json_extract(t.payload_json, '$.settledOverride') AS settledOverride,
              json_extract(t.payload_json, '$.snoozedUntil') AS snoozedUntil,
              r.run_id AS runId,
              r.status AS runStatus,
              r.requested_at AS runRequestedAt,
              r.completed_at AS runCompletedAt
         FROM orchestration_v2_projection_threads t
         JOIN orchestration_v2_projection_runs r
           ON r.thread_id = t.thread_id
          AND r.ordinal = (SELECT max(ordinal) FROM orchestration_v2_projection_runs WHERE thread_id = t.thread_id)
         LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.archived_at IS NULL
          AND t.deleted_at IS NULL
          AND t.updated_at >= ?1
          AND coalesce(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'`,
    )
    .all(since);
  const requests = db
    .query<PendingRequestRow, []>(
      `SELECT runtime_request_id AS id, thread_id AS threadId, kind, created_at AS createdAt
         FROM orchestration_v2_projection_runtime_requests
        WHERE status = 'pending'`,
    )
    .all();
  const lastSeen = db
    .query<{ lastSeen: string | null }, [string]>(
      `SELECT max(json_extract(payload_json, '$.lastVisitedAt')) AS lastSeen
         FROM orchestration_v2_projection_threads
        WHERE updated_at >= ?1`,
    )
    .get(since);
  return {
    takenAt: now.toISOString(),
    lastSeenInT3At: lastSeen?.lastSeen ?? null,
    items: classifyThreads(threads, requests, now, windowDays),
  };
}

export function classifyThreads(
  threads: ThreadRow[],
  requests: PendingRequestRow[],
  now: Date,
  windowDays: number,
): WaitingThread[] {
  const nowIso = now.toISOString();
  const oldest = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const requestsByThread = Map.groupBy(requests, (request) => request.threadId);
  const items: WaitingThread[] = [];

  for (const thread of threads) {
    if (thread.snoozedUntil !== null && thread.snoozedUntil > nowIso) continue;

    // A pending request from an earlier run is a leftover T3 never closed, not a live question.
    const live = (requestsByThread.get(thread.threadId) ?? []).filter(
      (request) => request.createdAt >= thread.runRequestedAt && request.kind !== "auth_refresh",
    );
    const questions = live.filter((request) => request.kind === "user_input");
    const approvals = live.filter((request) => request.kind !== "user_input");

    let status: WaitingStatus;
    let waitingSince: string;
    let pending: PendingRequestRow[] = [];
    if (questions.length > 0) {
      status = "needs_answer";
      pending = questions;
      waitingSince = earliest(questions);
    } else if (approvals.length > 0) {
      status = "needs_approval";
      pending = approvals;
      waitingSince = earliest(approvals);
    } else if ((thread.runStatus === "completed" || thread.runStatus === "failed") && thread.runCompletedAt) {
      if (thread.settledOverride === "settled") continue;
      status = thread.runStatus === "completed" ? "finished" : "failed";
      waitingSince = thread.runCompletedAt;
    } else {
      continue;
    }
    if (waitingSince < oldest) continue;

    const ended = status === "finished" || status === "failed";
    items.push({
      threadId: thread.threadId,
      projectId: thread.projectId,
      project: thread.project,
      title: thread.title,
      status,
      waitingSince,
      runId: thread.runId,
      runtimeMode: thread.runtimeMode,
      pendingRequestIds: pending.map((request) => request.id).sort(),
      unread: ended ? thread.lastVisitedAt === null || thread.lastVisitedAt < waitingSince : true,
    });
  }
  return items.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
}

function earliest(requests: PendingRequestRow[]): string {
  return requests.reduce((min, request) => (request.createdAt < min ? request.createdAt : min), requests[0]!.createdAt);
}
