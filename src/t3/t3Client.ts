import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readSecret, stringSetting } from "../lib/config";

export const T3_TOKEN_SECRET = "t3-mcp-token";

export function t3BaseUrl(): string {
  return stringSetting("T3_URL", "http://127.0.0.1:3773");
}

export interface T3ToolResult {
  text: string;
  isError: boolean;
}

/** The T3 MCP tools the gateway is allowed to reach. Anything else is unreachable by construction. */
export type T3ToolName =
  | "t3_pending_request_read"
  | "t3_pending_request_respond"
  | "t3_thread_send";

export type T3Caller = (name: T3ToolName, args: Record<string, unknown>) => Promise<T3ToolResult>;

/** Calls one tool on T3's own MCP endpoint over loopback with the gateway's local credential. */
export async function callT3(name: T3ToolName, args: Record<string, unknown>, token = readSecret(T3_TOKEN_SECRET)): Promise<T3ToolResult> {
  const client = new Client({ name: "grok-bot-setup-gateway", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", t3BaseUrl()), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool(await resolveTool(client, name, args));
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
      .join("\n");
    return { text, isError: result.isError === true };
  } finally {
    await client.close();
  }
}

const MERGED_PENDING_REQUEST: Partial<Record<T3ToolName, string>> = {
  t3_pending_request_read: "read",
  t3_pending_request_respond: "respond",
};

/**
 * T3 nightlies after 2026-10-26 merged the two pending-request tools into `t3_pending_request` with an
 * `action`. Ask the server which one it has, so a T3 update does not break answering. Drop the old names
 * once no supported T3 still ships them.
 */
async function resolveTool(client: Client, name: T3ToolName, args: Record<string, unknown>) {
  const action = MERGED_PENDING_REQUEST[name];
  if (!action) return { name, arguments: args };
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  if (tools.includes(name) || !tools.includes("t3_pending_request")) return { name, arguments: args };
  return { name: "t3_pending_request", arguments: { action, ...args } };
}

export async function listT3Tools(token: string): Promise<string[]> {
  const client = new Client({ name: "grok-bot-setup-pair-check", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", t3BaseUrl()), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}
