# Security

This project connects a cloud assistant to coding agents that can run commands on your machine. Read this before you turn on answering from chat.

## The one thing to understand

**Replying to a full-access T3 thread is the same as running commands on your machine.** If you can type "delete the build folder" into a thread from your phone, so can anyone who controls what your assistant sends. Everything below narrows *who* can send and *where*, but it cannot make that capability harmless. If that is not acceptable, run alerts only (skip the gateway), or set `GATEWAY_READ_ONLY=1`, or pair the gateway with `grok-t3 pair auto` so it can only reach auto-mode threads.

## What protects what

| Layer | Protects against | How |
|---|---|---|
| No public listener | Internet scanning and exploits | The gateway binds `127.0.0.1`. cloudflared only dials out. Nothing new is opened on your firewall. |
| Locally managed tunnel | A compromised Cloudflare account re-routing the tunnel to other ports | Ingress rules live in `/etc/cloudflared/grok-t3/config.yml` (root, 0600): one hostname, path `^/mcp$`, then `http_status:404`. |
| Cloudflare Access, Service Auth only | Anyone without the service token | The only policy is `non_identity` with one service token. Failures get a 401 at the edge and never reach your box. |
| Access JWT check in the gateway | Access being deleted or misconfigured later | The gateway verifies `Cf-Access-Jwt-Assertion` against your team's keys and the app's AUD, and refuses to start without that config. |
| Gateway bearer | Other processes on the same machine, and anyone who obtains only the Access token | Compared in constant time on every request. |
| Four tools, waiting threads only | A stolen or misused assistant credential | No launching, approving, steering, interrupting, settings or repo access. Writes are refused unless the thread is waiting on you right now (top-level, not archived, not settled, recent). Replies only go to finished threads you have not opened since they ended, which are the ones you get alerted about, and are always a new queued turn. |
| Caps and audit | Runaway or injected loops | At most 30 write attempts per day by default, one at a time, 4,000 characters each; batch requests are rejected. Every write is appended to `~/.local/state/grok-bot-setup/t3-gateway-audit.jsonl` (time, tool, thread, size, SHA-256; no content). The message itself is visible in the T3 thread. |
| Separate T3 grant | The gateway itself being compromised | Its credential is its own revocable grant ("grok-bot-setup gateway") in T3's Settings → Sharing & access, separate from your sessions, and it expires after 30 days. |
| Watcher has no credentials to T3 | A watcher bug leaking control | It opens T3's database read-only and holds only the webhook secrets. |
| Metadata-only alerts | Your code and conversations sitting in a cloud inbox | Alerts carry ids, titles, status and times. Titles can be turned off (`PAYLOAD_INCLUDE_TITLES=0`). Content leaves only when the assistant calls `read_waiting_thread`, truncated to 4,000 characters per item. |
| systemd sandboxing | A bug escalating on the host | User units run with `NoNewPrivileges`, read-only system and home except their state dir, private /tmp, restricted address families. cloudflared runs as a throwaway `DynamicUser` with no home access and no capabilities. |
| Secret hygiene | Secrets on disk or in logs | Secrets are 0600 files in a 0700 directory; the code refuses to read group- or world-readable secret files. Nothing prints or logs them. `scripts/check-secrets.sh` runs gitleaks and a private word list before every push. |

## What is still at risk

- **Prompt injection.** `read_waiting_thread` returns text written by a coding agent, which may have read web pages, issues or files written by someone else. That text could try to make the assistant send a reply. The gateway marks it as untrusted and the routine prompt tells the assistant to send only words you wrote or explicitly approved, but that is an instruction to a model, not a guarantee. Requiring a confirmation step in the prompt (see [docs/grok-routine.md](docs/grok-routine.md)) is the main defense.
- **Your assistant account.** The webhook secret, service token and bearer all live in the assistant's settings. Anyone who controls that account can answer waiting threads. Use strong authentication on it.
- **Cloudflare sees the traffic.** TLS ends at Cloudflare's edge, so the content the assistant reads or sends passes through Cloudflare in the clear on their side.
- **The assistant keeps what it reads.** Anything it reads may stay in its chat history and notes files.
- **Unofficial T3 internals.** The watcher reads T3's private database layout. A T3 update could change what "waiting" means in ways the schema check does not catch.

## Rotating secrets

| Secret | Rotate with |
|---|---|
| Gateway bearer | `grok-t3 new-bearer`, `systemctl --user restart grok-t3-gateway`, update the assistant's `Authorization` header |
| Access service token | Zero Trust → Access → Service credentials → refresh, then update both `CF-Access-*` headers in the assistant |
| Gateway's T3 credential | `grok-t3 pair` (renews; revoke the old one in T3 if you want it gone before it expires) |
| Webhook secret | Rotate in the routine's panel, then overwrite `secrets/grok-webhook-authorization` |
| Tunnel credentials | `bin/grok-t3-cloudflare teardown` and provision again |

## Reporting a vulnerability

Please open a private security advisory on this repository (Security → Report a vulnerability) rather than a public issue.
