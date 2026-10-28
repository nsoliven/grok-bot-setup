# Setup

About 20 minutes. Commands run on the Linux box where T3 Code runs, as your normal user unless marked `sudo`.

## 0. Before you start

```bash
systemctl --user status >/dev/null && echo "user systemd ok"
loginctl show-user "$USER" -p Linger      # want Linger=yes; if not: sudo loginctl enable-linger "$USER"
bun --version                             # 1.2 or newer
curl -s http://127.0.0.1:3773/.well-known/oauth-protected-resource   # T3 answers on loopback
```

Clone and install:

```bash
git clone https://github.com/nsoliven/grok-bot-setup.git ~/Code/grok-bot-setup
cd ~/Code/grok-bot-setup
bun install
scripts/install.sh install
```

This creates `~/.config/grok-bot-setup/` (0700) with `config.env` and `secrets/`, installs the watcher's user unit, and links `grok-t3` into `~/.local/bin`. The watcher does not start until its secrets exist.

Check what it sees:

```bash
grok-t3 status
```

## 1. Alerts

1. In Grok Bot, create a routine with a webhook trigger and the prompt from [grok-routine.md](grok-routine.md).
2. Save its two values as secret files:

   ```bash
   umask 077
   cat > ~/.config/grok-bot-setup/secrets/grok-webhook-url             # paste, Enter, Ctrl-D
   cat > ~/.config/grok-bot-setup/secrets/grok-webhook-authorization   # type "Bearer ", paste the key, Enter, Ctrl-D
   ```

3. Test and start:

   ```bash
   grok-t3 test-webhook          # the assistant should say "T3 alerts are connected."
   scripts/install.sh install
   journalctl --user -u grok-t3-watcher -f
   ```

You can stop here if you only want alerts.

## 2. Cloudflare

### API token (setup only)

Create a custom API token at dash.cloudflare.com → My Profile → API Tokens with:

| Scope | Permission |
|---|---|
| Account | Cloudflare Tunnel: Edit |
| Account | Access: Apps and Policies: Edit |
| Account | Access: Organizations, Identity Providers, and Groups: Edit |
| Zone (your zone only) | DNS: Edit |
| Zone (your zone only) | Zone: Read |

Identity Providers needs Edit only if your account has no one-time PIN login yet; provisioning adds one. Limit the token to your zone, a short expiry, and your server's public IPv4 address (Client IP address filtering); provisioning calls the API over IPv4 so that filter works on dual-stack hosts. You can delete the token from Cloudflare when setup is done. You only need it again for `teardown`.

### Provision

Pick a hostname nobody would guess, like `t3-<random>.example.com`, and the email that may open the sign-in pages.

```bash
umask 077; cat > ~/cf-token              # paste, Enter, Ctrl-D
CLOUDFLARE_API_TOKEN_FILE=~/cf-token bin/grok-t3-cloudflare provision \
  --zone example.com \
  --hostname t3-x7k2.example.com \
  --allow-email you@example.com \
  --out ~/.config/grok-bot-setup/handoff
```

This creates:

- the tunnel (locally managed) and a proxied CNAME;
- an Access app on the whole hostname that allows only your email, with a one-time PIN;
- a second Access app that bypasses Access for the six paths the assistant's servers call.

IDs go to `~/.config/grok-bot-setup/cloudflare.json` for teardown. The tunnel credentials go to the handoff directory (0600), never printed.

If your token cannot read the Zero Trust organization, add `--team-domain yourteam.cloudflareaccess.com`.

### Tunnel service (sudo)

```bash
scripts/install-tunnel.sh install \
  --tunnel-id <tunnel id printed above> \
  --hostname t3-x7k2.example.com \
  --credentials ~/.config/grok-bot-setup/handoff/tunnel.json
shred -u ~/.config/grok-bot-setup/handoff/tunnel.json
```

This installs `cloudflared` from Cloudflare's signed apt repository if needed, writes `/etc/cloudflared/grok-t3/` (root, 0600), and starts `cloudflared-grok-t3.service` as a sandboxed `DynamicUser`. It forwards to T3 on `127.0.0.1:3773`; pass `--port` if yours differs.

### Check it from outside

```bash
h=https://t3-x7k2.example.com
curl -s -o /dev/null -w '%{http_code}  /mcp without a token (want 401)\n' -X POST $h/mcp
curl -s $h/.well-known/oauth-authorization-server | grep -o '"issuer":"[^"]*"'   # want your https hostname
curl -s -o /dev/null -w '%{http_code}  approval page (want 302 to your Access login)\n' $h/connect-agent
curl -s -o /dev/null -w '%{http_code}  rest of T3 (want 404)\n' $h/api/auth/clients
```

## 3. Connect the assistant

Add the MCP connector and the answering instructions from [grok-routine.md](grok-routine.md). The connector opens T3's sign-in: log in to Access with the PIN from your email, then enter a pairing code on T3's page and choose the access level. [how-it-works.md](how-it-works.md#signing-in) shows how to get a pairing code.

## Updating

```bash
cd ~/Code/grok-bot-setup && git pull && bun install
scripts/install.sh install
systemctl --user restart grok-t3-watcher
```

After a T3 update, run `grok-t3 status`. If it reports a schema problem, alerts are off until this project is updated for the new T3. If the assistant's sign-in page stops loading, T3 may have moved a path the tunnel allowlist needs.

## Removing everything

Tear down Cloudflare first: it reads the IDs saved in the config directory, which `--purge` deletes.

```bash
scripts/install-tunnel.sh uninstall
CLOUDFLARE_API_TOKEN_FILE=~/cf-token bin/grok-t3-cloudflare teardown
scripts/install.sh uninstall --purge
```

Then revoke the assistant's client in T3 (Settings → Sharing & access), delete the routine and the connector in Grok Bot, and delete the Cloudflare API token.
