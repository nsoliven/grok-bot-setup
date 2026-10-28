# Security

This project connects a cloud assistant to coding agents that can run commands on your machine. Read this before you turn on answering from chat.

## The one thing to understand

**An assistant signed in to T3 with full access can do what you can do in T3.** That includes replying to full-access threads and starting new ones, which is the same as running commands on your machine. Anyone who controls what your assistant sends can do the same. Everything below narrows *who* can reach T3 and *how*, but it cannot make that power harmless.

You choose the assistant's ceiling when you approve its sign-in:

- **Read only**: it can list and read threads, and change nothing.
- **Supervised** or **Auto**: it can message threads, but nothing it starts or steers can run with more than that mode. It cannot reach full-access threads.
- **Full access**: it can answer every thread you run, including full-access ones.

If none of these is acceptable, run alerts only and skip the tunnel.

## What protects what

| Layer | Protects against | How |
|---|---|---|
| No public listener | Internet scanning and exploits | T3 stays on `127.0.0.1`. cloudflared only dials out. Nothing new is opened on your firewall. |
| Locally managed tunnel with a path allowlist | Reaching the rest of T3 (its app, API, websocket, settings) | Ingress rules live in `/etc/cloudflared/grok-t3/config.yml` (root, 0600): one hostname, only the MCP sign-in and `/mcp` paths, then `http_status:404`. A compromised Cloudflare account cannot re-route the tunnel. A test keeps the allowlist from loosening. |
| Cloudflare Access login | Anyone loading the approval page or the other sign-in pages | An Access app covers the whole hostname and allows only your email, with a one-time PIN. Only `/mcp`, the OAuth discovery documents, `/oauth/mcp/register` and `/oauth/mcp/token` bypass it, because the assistant's servers call those without a browser. |
| T3's OAuth | Anyone calling `/mcp` or exchanging codes | `/mcp` needs a T3-issued bearer token. Getting one needs your approval on the Access-protected page **and** a single-use pairing code from your T3. PKCE (S256) binds the code to the client that started the sign-in. |
| T3's per-client grant | A lost or misused assistant token | The assistant is its own client in T3's Settings → Sharing & access, with the ceiling you chose. Revoke it there at any time; it also expires after 30 days. |
| Watcher has no credentials to T3 | A watcher bug leaking control | It opens T3's database read-only, reads no message text, and holds only the webhook secrets. |
| Metadata-only alerts | Your code and conversations sitting in a cloud inbox | Alerts carry ids, titles, status and times. Titles can be turned off (`PAYLOAD_INCLUDE_TITLES=0`). |
| systemd sandboxing | A bug escalating on the host | The watcher runs with `NoNewPrivileges`, read-only system and home except its state dir, private /tmp and restricted address families. cloudflared runs as a throwaway `DynamicUser` with no home access and no capabilities. |
| Secret hygiene | Secrets on disk or in logs | Secrets are 0600 files in a 0700 directory; the code refuses to read group- or world-readable secret files. Nothing prints or logs them. `scripts/check-secrets.sh` runs gitleaks and a private word list before every push. |

## What is still at risk

- **Prompt injection.** Thread content is written by coding agents, which may have read web pages, issues or files written by someone else. That text could try to make the assistant send a message or start a thread. The answering instructions in [docs/grok-routine.md](docs/grok-routine.md) tell the assistant to send only words you wrote or approved, and to start nothing unless you ask. That is an instruction to a model, not a guarantee.
- **Your assistant account.** The assistant holds the T3 token and the webhook secret. Anyone who controls that account gets the access you approved. Use strong authentication on it.
- **The assistant can read every thread** that its grant allows, not only the ones waiting on you. Anything it reads may stay in its chat history and notes.
- **The open paths are reachable by anyone.** `/mcp`, the discovery documents, client registration and the token endpoint skip Access, so the internet can reach them. Without a token they return 401 or an OAuth error. Any bug in T3's handling of those requests is exposed.
- **Cloudflare sees the traffic.** TLS ends at Cloudflare's edge, so what the assistant reads or sends passes through Cloudflare in the clear on their side.
- **Unofficial T3 internals.** The watcher reads T3's private database layout. A T3 update could change what "waiting" means in ways the schema check does not catch.

## Rotating secrets

| Secret | Rotate with |
|---|---|
| The assistant's T3 sign-in | Revoke it in T3 (Settings → Sharing & access), then reconnect the connector and approve again |
| Webhook secret | Rotate in the routine's panel, then overwrite `secrets/grok-webhook-authorization` |
| Tunnel credentials | `bin/grok-t3-cloudflare teardown` and provision again |

## Reporting a vulnerability

Please open a private security advisory on this repository (Security → Report a vulnerability) rather than a public issue.
