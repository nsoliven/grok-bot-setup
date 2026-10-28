import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, writePrivateFile, writeSecret } from "../lib/config";
import { listT3Tools, t3BaseUrl, T3_TOKEN_SECRET } from "./t3Client";
import { files, type CredentialMeta } from "./files";

/**
 * Gets the gateway its own T3 MCP credential without a browser:
 * mint a 10-minute single-use pairing code with the running T3's CLI, then run T3's OAuth
 * (dynamic registration, PKCE, pairing-code approval, code exchange) over loopback.
 * The pairing code and the token never touch stdout or logs.
 *
 * T3 MCP grants last 30 days and cannot be refreshed, so this runs again before expiry
 * (the watcher warns you three days ahead). Revoke in T3: Settings > Sharing & access.
 */

export type PairAccess = "full-access" | "auto" | "approval-required";

const SCOPES: Record<PairAccess, string[]> = {
  // T3 requires these extra scopes on the pairing code before it grants a full-access ceiling.
  "full-access": ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"],
  auto: ["orchestration:read", "orchestration:operate"],
  "approval-required": ["orchestration:read", "orchestration:operate"],
};

const CLIENT_NAME = "grok-bot-setup gateway";
// T3 matches http loopback redirects by host and path, so nothing needs to listen here.
const REDIRECT_URI = "http://127.0.0.1/grok-bot-setup/callback";

/** The t3 binary matching the running server (the one on PATH can be stale). */
export function runningT3Binary(): string {
  const runtime = JSON.parse(readFileSync(join(paths.t3Home, "userdata", "server-runtime.json"), "utf8")) as { serverVersion?: string };
  const versions = readdirSync(join(paths.t3Home, "runtime", "versions"));
  const version = runtime.serverVersion && versions.includes(runtime.serverVersion) ? runtime.serverVersion : null;
  if (!version) throw new Error("Could not find the t3 binary for the running server. Is T3 running?");
  return join(paths.t3Home, "runtime", "versions", version, "t3");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function mintPairingCode(access: PairAccess): Promise<string> {
  const args = ["auth", "pairing", "create", "--json", "--ttl", "10m", "--label", CLIENT_NAME];
  for (const scope of SCOPES[access]) args.push("--scope", scope);
  const child = Bun.spawn([runningT3Binary(), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, T3CODE_HOME: paths.t3Home } });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`t3 auth pairing create exited with ${code}.`);
  const start = stdout.indexOf("{");
  const parsed = JSON.parse(stdout.slice(start)) as { credential?: string };
  if (!parsed.credential) throw new Error("t3 auth pairing create returned no credential.");
  return parsed.credential;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, t3BaseUrl()), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

export async function pair(access: PairAccess): Promise<CredentialMeta> {
  const registration = await post("/oauth/mcp/register", { client_name: CLIENT_NAME, redirect_uris: [REDIRECT_URI] });
  if (!registration.ok) throw new Error(`T3 refused client registration (HTTP ${registration.status}).`);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const authorization = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  };

  const decision = await post("/oauth/mcp/decision", {
    authorization,
    decision: { _tag: "pairing-code", access, code: await mintPairingCode(access) },
  });
  if (!decision.ok) {
    const detail = ((await decision.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${decision.status}`;
    throw new Error(`T3 refused the approval: ${detail}`);
  }
  const redirect = new URL(((await decision.json()) as { redirectTo: string }).redirectTo);
  const code = redirect.searchParams.get("code");
  if (!code || redirect.searchParams.get("state") !== state) throw new Error("T3's approval redirect was missing the code or state.");

  const tokenResponse = await fetch(new URL("/oauth/mcp/token", t3BaseUrl()), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
  });
  if (!tokenResponse.ok) throw new Error(`T3 refused the code exchange (HTTP ${tokenResponse.status}).`);
  const token = (await tokenResponse.json()) as { access_token: string; expires_in: number };

  const tools = await listT3Tools(token.access_token);
  if (!tools.includes("t3_thread_send")) throw new Error("The new credential cannot see t3_thread_send.");

  writeSecret(T3_TOKEN_SECRET, token.access_token);
  const now = new Date();
  const meta: CredentialMeta = {
    access,
    pairedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
  };
  writePrivateFile(files.credentialMeta, JSON.stringify(meta));
  return meta;
}
