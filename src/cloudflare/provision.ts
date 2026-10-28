import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, paths, readJsonFile, writePrivateFile } from "../lib/config";

/**
 * Creates (and tears down) everything Cloudflare-side, through the API:
 *   - a locally managed tunnel (routing stays in a file on the host, not the dashboard)
 *   - a proxied CNAME for one hostname
 *   - an Access service token, a Service Auth policy that allows only that token,
 *     and a self-hosted Access app on the hostname that returns 401 instead of a login page
 *
 * The API token is read from the file named by CLOUDFLARE_API_TOKEN_FILE and is only needed
 * here. One-time secrets (tunnel credentials, the service token) are written to 0600 files
 * in --out and never printed.
 *
 *   bun run src/cloudflare/provision.ts provision --zone example.com --hostname t3hook-xyz.example.com --out DIR
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
  serviceTokenId: string;
  policyId: string;
  appId: string;
  aud: string;
}

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
  const out = flag(args, "out");
  const name = args.includes("--name") ? flag(args, "name") : "grok-bot-setup-t3";
  if (!hostname.endsWith(`.${zoneName}`)) throw new Error("--hostname must be inside --zone.");
  ensurePrivateDir(out);
  if (readJsonFile<Partial<Provisioned>>(recordFile())?.accountId) throw new Error(`Already provisioned (${recordFile()}). Run teardown first.`);

  const [zone] = await cf<Array<{ id: string; account: { id: string } }>>("GET", `/zones?name=${encodeURIComponent(zoneName)}`);
  if (!zone) throw new Error(`Zone ${zoneName} not found for this token.`);
  const accountId = zone.account.id;

  let teamDomain = args.includes("--team-domain") ? flag(args, "team-domain") : "";
  if (!teamDomain) {
    const organization = await cf<{ auth_domain: string }>("GET", `/accounts/${accountId}/access/organizations`);
    teamDomain = organization.auth_domain;
  }

  const record: Partial<Provisioned> = { accountId, zoneId: zone.id, hostname, teamDomain };
  const save = () => writePrivateFile(recordFile(), JSON.stringify(record, null, 2));
  try {
    const tunnelSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const tunnel = await cf<{ id: string }>("POST", `/accounts/${accountId}/cfd_tunnel`, {
      name,
      config_src: "local",
      tunnel_secret: tunnelSecret,
    });
    record.tunnelId = tunnel.id;
    save();
    writePrivateFile(
      join(out, "tunnel.json"),
      JSON.stringify({ AccountTag: accountId, TunnelSecret: tunnelSecret, TunnelID: tunnel.id }),
    );

    const dns = await cf<{ id: string }>("POST", `/zones/${zone.id}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
      comment: "grok-bot-setup gateway tunnel",
    });
    record.dnsRecordId = dns.id;
    save();

    const serviceToken = await cf<{ id: string; client_id: string; client_secret: string }>(
      "POST",
      `/accounts/${accountId}/access/service_tokens`,
      { name: `${name} assistant`, duration: "8760h" },
    );
    record.serviceTokenId = serviceToken.id;
    save();
    writePrivateFile(
      join(out, "access-service-token.json"),
      JSON.stringify({ "CF-Access-Client-Id": serviceToken.client_id, "CF-Access-Client-Secret": serviceToken.client_secret }, null, 2),
    );

    const policy = await cf<{ id: string }>("POST", `/accounts/${accountId}/access/policies`, {
      name: `${name} service token only`,
      decision: "non_identity",
      include: [{ service_token: { token_id: serviceToken.id } }],
    });
    record.policyId = policy.id;
    save();

    const app = await cf<{ id: string; aud: string }>("POST", `/accounts/${accountId}/access/apps`, {
      name,
      type: "self_hosted",
      domain: hostname,
      session_duration: "15m",
      app_launcher_visible: false,
      service_auth_401_redirect: true,
      policies: [{ id: policy.id, precedence: 1 }],
    });
    record.appId = app.id;
    record.aud = app.aud;
    save();
  } catch (error) {
    console.error("Provisioning stopped part way. What was created is recorded; run teardown to remove it.");
    throw error;
  }

  writePrivateFile(join(out, "access.env"), `ACCESS_TEAM_DOMAIN=${teamDomain}\nACCESS_AUD=${record.aud}\n`);
  console.log(`Provisioned ${hostname}.`);
  console.log(`  tunnel id: ${record.tunnelId}`);
  console.log(`  wrote ${out}/tunnel.json, access-service-token.json (secret) and access.env`);
}

async function teardown(): Promise<void> {
  const record = readJsonFile<Partial<Provisioned>>(recordFile());
  if (!record?.accountId) throw new Error(`Nothing recorded in ${recordFile()}.`);
  const account = `/accounts/${record.accountId}`;
  const steps: Array<[string, string | undefined, () => Promise<unknown>]> = [
    ["Access app", record.appId, () => cf("DELETE", `${account}/access/apps/${record.appId}`)],
    ["Access policy", record.policyId, () => cf("DELETE", `${account}/access/policies/${record.policyId}`)],
    ["service token", record.serviceTokenId, () => cf("DELETE", `${account}/access/service_tokens/${record.serviceTokenId}`)],
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
  else console.log("usage: provision --zone Z --hostname H --out DIR [--name N] [--team-domain T] | teardown");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
