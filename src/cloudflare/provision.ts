import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, paths, readJsonFile, writePrivateFile } from "../lib/config";

/**
 * Creates (and tears down) everything Cloudflare-side, through the API:
 *   - a locally managed tunnel (routing stays in a file on the host, not the dashboard)
 *   - a proxied CNAME for one hostname
 *   - an Access app on the whole hostname that only your email can pass (one-time PIN login), so
 *     the browser pages of T3's sign-in are reachable only by you
 *   - a second, narrower Access app that bypasses Access for the paths a hosted assistant's servers
 *     call during and after sign-in. T3's own OAuth protects those.
 *
 * The API token is read from the file named by CLOUDFLARE_API_TOKEN_FILE and is only needed
 * here. The tunnel credentials are written to a 0600 file in --out and never printed.
 *
 *   bun run src/cloudflare/provision.ts provision --zone example.com --hostname t3-xyz.example.com --allow-email you@example.com --out DIR
 *   bun run src/cloudflare/provision.ts teardown
 */

const API = "https://api.cloudflare.com/client/v4";
const recordFile = () => join(paths.configDir, "cloudflare.json");

interface Provisioned {
  accountId: string;
  zoneId: string;
  hostname: string;
  teamDomain: string;
  tunnelId: string;
  dnsRecordId: string;
  /** Set only when provisioning created the one-time PIN login method, so teardown leaves an existing one alone. */
  createdIdpId: string;
  loginPolicyId: string;
  loginAppId: string;
  bypassPolicyId: string;
  bypassAppId: string;
}

/**
 * What a hosted assistant's servers call without a browser: OAuth discovery, client registration,
 * the code exchange, and MCP itself. Everything else on the hostname needs your Access login.
 * Keep in sync with the tunnel's path allowlist in deploy/cloudflared/config.example.yml.
 */
const MACHINE_PATHS = [
  "/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/mcp/register",
  "/oauth/mcp/token",
];

function apiToken(): string {
  const file = process.env.CLOUDFLARE_API_TOKEN_FILE;
  if (!file) throw new Error("Set CLOUDFLARE_API_TOKEN_FILE to a file holding the API token.");
  return readFileSync(file, "utf8").trim();
}

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiToken()}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as { success: boolean; result: T; errors?: Array<{ code: number; message: string }> };
  if (!json.success) {
    const errors = (json.errors ?? []).map((error) => `${error.code} ${error.message}`).join("; ");
    throw new Error(`Cloudflare ${method} ${path.replace(/[0-9a-f]{32}/g, ":id")} failed: ${errors || response.status}`);
  }
  return json.result;
}

function flag(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

async function provision(args: string[]): Promise<void> {
  const zoneName = flag(args, "zone");
  const hostname = flag(args, "hostname").toLowerCase();
  const email = flag(args, "allow-email").toLowerCase();
  const out = flag(args, "out");
  const name = args.includes("--name") ? flag(args, "name") : "grok-bot-setup-t3";
  if (!hostname.endsWith(`.${zoneName}`)) throw new Error("--hostname must be inside --zone.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("--allow-email looks wrong.");
  ensurePrivateDir(out);
  if (readJsonFile<Partial<Provisioned>>(recordFile())?.accountId) throw new Error(`Already provisioned (${recordFile()}). Run teardown first.`);

  const [zone] = await cf<Array<{ id: string; account: { id: string } }>>("GET", `/zones?name=${encodeURIComponent(zoneName)}`);
  if (!zone) throw new Error(`Zone ${zoneName} not found for this token.`);
  const accountId = zone.account.id;
  const account = `/accounts/${accountId}`;

  let teamDomain = args.includes("--team-domain") ? flag(args, "team-domain") : "";
  if (!teamDomain) teamDomain = (await cf<{ auth_domain: string }>("GET", `${account}/access/organizations`)).auth_domain;

  const record: Partial<Provisioned> = { accountId, zoneId: zone.id, hostname, teamDomain };
  const save = () => writePrivateFile(recordFile(), JSON.stringify(record, null, 2));
  try {
    const tunnelSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const tunnel = await cf<{ id: string }>("POST", `${account}/cfd_tunnel`, { name, config_src: "local", tunnel_secret: tunnelSecret });
    record.tunnelId = tunnel.id;
    save();
    writePrivateFile(join(out, "tunnel.json"), JSON.stringify({ AccountTag: accountId, TunnelSecret: tunnelSecret, TunnelID: tunnel.id }));

    const dns = await cf<{ id: string }>("POST", `/zones/${zone.id}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
      comment: "grok-bot-setup T3 tunnel",
    });
    record.dnsRecordId = dns.id;
    save();

    const idps = await cf<Array<{ id: string; type: string }>>("GET", `${account}/access/identity_providers`);
    let idpId = idps.find((idp) => idp.type === "onetimepin")?.id;
    if (!idpId) {
      idpId = (await cf<{ id: string }>("POST", `${account}/access/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} })).id;
      record.createdIdpId = idpId;
      save();
    }

    const loginPolicy = await cf<{ id: string }>("POST", `${account}/access/policies`, {
      name: `${name} owner only`,
      decision: "allow",
      include: [{ email: { email } }],
    });
    record.loginPolicyId = loginPolicy.id;
    save();
    const loginApp = await cf<{ id: string }>("POST", `${account}/access/apps`, {
      name: `${name} sign-in pages`,
      type: "self_hosted",
      domain: hostname,
      destinations: [{ type: "public", uri: hostname }],
      allowed_idps: [idpId],
      auto_redirect_to_identity: true,
      session_duration: "1h",
      app_launcher_visible: false,
      policies: [{ id: loginPolicy.id, precedence: 1 }],
    });
    record.loginAppId = loginApp.id;
    save();

    // Access applies the app with the most specific path, so these paths skip the login above.
    const bypassPolicy = await cf<{ id: string }>("POST", `${account}/access/policies`, {
      name: `${name} assistant server calls`,
      decision: "bypass",
      include: [{ everyone: {} }],
    });
    record.bypassPolicyId = bypassPolicy.id;
    save();
    const bypassApp = await cf<{ id: string }>("POST", `${account}/access/apps`, {
      name: `${name} MCP and OAuth endpoints`,
      type: "self_hosted",
      domain: `${hostname}${MACHINE_PATHS[0]}`,
      destinations: MACHINE_PATHS.map((path) => ({ type: "public", uri: `${hostname}${path}` })),
      app_launcher_visible: false,
      policies: [{ id: bypassPolicy.id, precedence: 1 }],
    });
    record.bypassAppId = bypassApp.id;
    save();
  } catch (error) {
    console.error("Provisioning stopped part way. What was created is recorded; run teardown to remove it.");
    throw error;
  }

  console.log(`Provisioned ${hostname}.`);
  console.log(`  tunnel id: ${record.tunnelId}`);
  console.log(`  wrote ${out}/tunnel.json (secret; install it with scripts/install-tunnel.sh, then shred it)`);
  console.log(`  MCP URL for the assistant: https://${hostname}/mcp`);
}

async function teardown(): Promise<void> {
  const record = readJsonFile<Partial<Provisioned>>(recordFile());
  if (!record?.accountId) throw new Error(`Nothing recorded in ${recordFile()}.`);
  const account = `/accounts/${record.accountId}`;
  const steps: Array<[string, string | undefined, () => Promise<unknown>]> = [
    ["bypass Access app", record.bypassAppId, () => cf("DELETE", `${account}/access/apps/${record.bypassAppId}`)],
    ["sign-in Access app", record.loginAppId, () => cf("DELETE", `${account}/access/apps/${record.loginAppId}`)],
    ["bypass policy", record.bypassPolicyId, () => cf("DELETE", `${account}/access/policies/${record.bypassPolicyId}`)],
    ["sign-in policy", record.loginPolicyId, () => cf("DELETE", `${account}/access/policies/${record.loginPolicyId}`)],
    ["one-time PIN login", record.createdIdpId, () => cf("DELETE", `${account}/access/identity_providers/${record.createdIdpId}`)],
    ["DNS record", record.dnsRecordId, () => cf("DELETE", `/zones/${record.zoneId}/dns_records/${record.dnsRecordId}`)],
    [
      "tunnel",
      record.tunnelId,
      async () => {
        await cf("DELETE", `${account}/cfd_tunnel/${record.tunnelId}/connections`).catch(() => {});
        return cf("DELETE", `${account}/cfd_tunnel/${record.tunnelId}`);
      },
    ],
  ];
  let failed = false;
  for (const [label, id, remove] of steps) {
    if (!id) continue;
    try {
      await remove();
      console.log(`removed ${label}`);
    } catch (error) {
      failed = true;
      console.error(`could not remove ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) throw new Error("Some pieces remain; fix the errors above and run teardown again.");
  writePrivateFile(recordFile(), "{}");
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "provision") await provision(rest);
  else if (command === "teardown") await teardown();
  else console.log("usage: provision --zone Z --hostname H --allow-email E --out DIR [--name N] [--team-domain T] | teardown");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
