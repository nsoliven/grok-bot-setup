import { describe, expect, test } from "bun:test";
import type { AuditEntry, AuditLog } from "../src/t3/audit";
import { createGatewayHandler, type GatewayDeps } from "../src/t3/gateway";
import type { WaitingThread } from "../src/t3/state";
import type { T3ToolName } from "../src/t3/t3Client";

const BEARER = "b".repeat(43);

function waiting(overrides: Partial<WaitingThread> = {}): WaitingThread {
  return {
    threadId: "done",
    projectId: "p",
    project: "proj",
    title: "Finished thread",
    status: "finished",
    waitingSince: "2026-10-28T11:00:00.000Z",
    runId: "run:done:1",
    runtimeMode: "full-access",
    pendingRequestIds: [],
    unread: true,
    ...overrides,
  };
}

function setup(overrides: Partial<GatewayDeps> = {}) {
  const calls: Array<{ name: T3ToolName; args: Record<string, unknown> }> = [];
  const entries: AuditEntry[] = [];
  const audit: AuditLog = { record: (entry) => entries.push(entry), writesInLastDay: () => entries.length };
  const deps: GatewayDeps = {
    bearer: BEARER,
    access: null,
    snapshot: () => ({
      takenAt: "",
      lastSeenInT3At: null,
      items: [waiting(), waiting({ threadId: "asks", status: "needs_answer", pendingRequestIds: ["req-1"] })],
    }),
    lastAgentMessage: () => ({ text: "Done. Want me to open the PR?", at: "2026-10-28T11:00:00.000Z" }),
    callT3: async (name, args) => {
      calls.push({ name, args });
      return { text: "{}", isError: false };
    },
    audit,
    readOnly: false,
    dailyWriteCap: 30,
    now: () => new Date("2026-10-28T12:00:00.000Z"),
    ...overrides,
  };
  return { handler: createGatewayHandler(deps), calls, entries };
}

let id = 0;
function rpc(method: string, params: unknown, headers: Record<string, string> = { authorization: `Bearer ${BEARER}` }) {
  return new Request("http://127.0.0.1:47731/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
}

async function callTool(handler: (r: Request) => Promise<Response>, name: string, args: Record<string, unknown>) {
  const response = await handler(rpc("tools/call", { name, arguments: args }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: body.result.content[0]!.text, isError: body.result.isError === true };
}

describe("gateway auth", () => {
  test("rejects a missing or wrong bearer before any MCP handling", async () => {
    const { handler } = setup();
    expect((await handler(rpc("tools/list", {}, {}))).status).toBe(401);
    expect((await handler(rpc("tools/list", {}, { authorization: `Bearer ${"x".repeat(43)}` }))).status).toBe(401);
  });

  test("requires a Cloudflare Access JWT when Access is configured", async () => {
    const { handler } = setup({ access: { teamDomain: "example.cloudflareaccess.com", aud: "aud" } });
    expect((await handler(rpc("tools/list", {}))).status).toBe(401);
    expect((await handler(rpc("tools/list", {}, { authorization: `Bearer ${BEARER}`, "cf-access-jwt-assertion": "not-a-jwt" }))).status).toBe(401);
  });

  test("serves only POST /mcp", async () => {
    const { handler } = setup();
    expect((await handler(new Request("http://127.0.0.1:47731/", { method: "POST" }))).status).toBe(404);
    expect((await handler(new Request("http://127.0.0.1:47731/mcp", { method: "GET" }))).status).toBe(405);
  });
});

describe("gateway tools", () => {
  test("exposes exactly four tools", async () => {
    const { handler } = setup();
    const response = await handler(rpc("tools/list", {}));
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual(["answer_question", "list_waiting", "read_waiting_thread", "reply_to_thread"]);
  });

  test("replies to a finished thread as a queued turn and audits it without its content", async () => {
    const { handler, calls, entries } = setup();
    expect(await callTool(handler, "reply_to_thread", { threadId: "done", message: "yes, open the PR" })).toEqual({ text: "Sent.", isError: false });
    expect(calls).toEqual([{ name: "t3_thread_send", args: { threadId: "done", message: "yes, open the PR", mode: "queue" } }]);
    expect(entries[0]).toMatchObject({ tool: "reply_to_thread", threadId: "done", ok: true, chars: 16 });
    expect(JSON.stringify(entries)).not.toContain("open the PR");
  });

  test("refuses threads that are not waiting, and requests that are not pending", async () => {
    const { handler, calls } = setup();
    expect((await callTool(handler, "reply_to_thread", { threadId: "some-running-thread", message: "rm -rf" })).isError).toBe(true);
    expect((await callTool(handler, "read_waiting_thread", { threadId: "some-running-thread" })).isError).toBe(true);
    expect((await callTool(handler, "answer_question", { threadId: "asks", requestId: "other", answers: { q: "a" } })).isError).toBe(true);
    expect((await callTool(handler, "reply_to_thread", { threadId: "asks", message: "hi" })).text).toContain("answer_question");
    expect(calls).toEqual([]);
  });

  test("answers a pending question through T3's respond tool", async () => {
    const { handler, calls } = setup();
    expect((await callTool(handler, "answer_question", { threadId: "asks", requestId: "req-1", answers: { q1: "Option A" } })).isError).toBe(false);
    expect(calls[0]).toEqual({ name: "t3_pending_request_respond", args: { threadId: "asks", requestId: "req-1", answers: { q1: "Option A" } } });
  });

  test("read-only mode and the daily cap block writes", async () => {
    const readOnly = setup({ readOnly: true });
    expect((await callTool(readOnly.handler, "reply_to_thread", { threadId: "done", message: "hi" })).text).toContain("read-only");
    const capped = setup({ dailyWriteCap: 1 });
    await callTool(capped.handler, "reply_to_thread", { threadId: "done", message: "one" });
    expect((await callTool(capped.handler, "reply_to_thread", { threadId: "done", message: "two" })).text).toContain("daily limit");
    expect(capped.calls).toHaveLength(1);
  });

  test("parallel writes cannot slip past the daily cap", async () => {
    const slowT3 = setup({
      dailyWriteCap: 1,
      callT3: async () => {
        await Bun.sleep(20);
        return { text: "{}", isError: false };
      },
    });
    const sends = ["a", "b", "c"].map((message) => callTool(slowT3.handler, "reply_to_thread", { threadId: "done", message }));
    const results = await Promise.all(sends);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(slowT3.entries).toHaveLength(1);
  });

  test("rejects JSON-RPC batches", async () => {
    const { handler, calls } = setup();
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply_to_thread", arguments: { threadId: "done", message: "a" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reply_to_thread", arguments: { threadId: "done", message: "b" } } },
    ]);
    const response = await handler(
      new Request("http://127.0.0.1:47731/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${BEARER}` },
        body,
      }),
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("will not reply to a finished thread you already opened in T3", async () => {
    const { handler, calls } = setup({
      snapshot: () => ({ takenAt: "", lastSeenInT3At: null, items: [waiting({ unread: false })] }),
    });
    const reply = await callTool(handler, "reply_to_thread", { threadId: "done", message: "hi" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("opened");
    expect(calls).toEqual([]);
  });

  test("internal errors reach the assistant without details, and a failed send is still audited", async () => {
    const { handler, entries } = setup({
      callT3: async () => {
        throw new Error("ENOENT: /home/someone/.config/grok-bot-setup/secrets/t3-mcp-token");
      },
    });
    const reply = await callTool(handler, "reply_to_thread", { threadId: "done", message: "hi" });
    expect(reply.isError).toBe(true);
    expect(reply.text).not.toContain("/home/");
    expect(entries).toMatchObject([{ tool: "reply_to_thread", ok: false }]);
  });

  test("marks thread content as untrusted when reading", async () => {
    const { handler } = setup();
    const read = await callTool(handler, "read_waiting_thread", { threadId: "done" });
    expect(read.text).toContain("UNTRUSTED CONTENT");
    expect(read.text).toContain("Want me to open the PR?");
  });
});
