import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { callT3 } from "../src/t3/t3Client";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  delete process.env.T3_URL;
});

/** A stand-in for T3's /mcp that offers `toolNames` and echoes back which tool got which arguments. */
function fakeT3(toolNames: string[]) {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const mcp = new McpServer({ name: "fake-t3", version: "0" });
      for (const name of toolNames) {
        mcp.registerTool(name, { inputSchema: { action: z.string().optional(), threadId: z.string(), requestId: z.string(), answers: z.unknown().optional() } }, (args) => ({
          content: [{ type: "text", text: JSON.stringify({ tool: name, args }) }],
        }));
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      return transport.handleRequest(request);
    },
  });
  process.env.T3_URL = `http://127.0.0.1:${server.port}`;
}

describe("callT3 across T3 versions", () => {
  test("uses the merged t3_pending_request tool when T3 only has that", async () => {
    fakeT3(["t3_pending_request", "t3_thread_send"]);
    const read = await callT3("t3_pending_request_read", { threadId: "t", requestId: "r" }, "token");
    expect(JSON.parse(read.text)).toEqual({ tool: "t3_pending_request", args: { action: "read", threadId: "t", requestId: "r" } });
    const respond = await callT3("t3_pending_request_respond", { threadId: "t", requestId: "r", answers: { q: "a" } }, "token");
    expect(JSON.parse(respond.text)).toEqual({ tool: "t3_pending_request", args: { action: "respond", threadId: "t", requestId: "r", answers: { q: "a" } } });
  });

  test("keeps the separate tools on a T3 that still has them", async () => {
    fakeT3(["t3_pending_request_read", "t3_pending_request_respond", "t3_thread_send"]);
    const read = await callT3("t3_pending_request_read", { threadId: "t", requestId: "r" }, "token");
    expect(JSON.parse(read.text)).toEqual({ tool: "t3_pending_request_read", args: { threadId: "t", requestId: "r" } });
  });
});
