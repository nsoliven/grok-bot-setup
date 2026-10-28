import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The tunnel's path allowlist is the only thing keeping the rest of T3 (its app, API and
// websocket) off the internet, so check it against the real config template.
const template = readFileSync(new URL("../deploy/cloudflared/config.example.yml", import.meta.url), "utf8");
const allow = new RegExp(/^\s*path:\s*(.+)$/m.exec(template)![1]!.trim());

describe("tunnel path allowlist", () => {
  test("lets through what T3's MCP sign-in and MCP itself need", () => {
    for (const path of [
      "/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth/mcp/register",
      "/oauth/mcp/token",
      "/oauth/mcp/authorize",
      "/oauth/mcp/approval",
      "/oauth/mcp/decision",
      "/connect-agent",
      "/assets/index-Bx1_9a.js",
      "/api/auth/session",
      "/.well-known/t3/environment",
    ]) {
      expect(allow.test(path)).toBe(true);
    }
  });

  test("keeps the rest of T3 unreachable", () => {
    for (const path of [
      "/",
      "/ws",
      "/settings",
      "/api/auth/clients",
      "/api/auth/pairing-token",
      "/api/auth/browser-session",
      "/api/auth/session/extra",
      "/oauth/token",
      "/mcp/extra",
      "/mcpx",
      "/assets/../api/auth/clients",
      "/assets/sub/dir.js",
      "/connect-agent/../ws",
    ]) {
      expect(allow.test(path)).toBe(false);
    }
  });
});
