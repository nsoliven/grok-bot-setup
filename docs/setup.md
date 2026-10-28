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

This creates `~/.config/grok-bot-setup/` (0700) with `config.env` and `secrets/`, installs two user units, and links `grok-t3` into `~/.local/bin`. Neither service starts until its secrets exist.

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
   cat > ~/.config/grok-bot-setup/secrets/grok-webhook-authorization   # paste, Enter, Ctrl-D
   ```

3. Test and start:

   ```bash
   grok-t3 test-webhook          # the assistant should say "T3 alerts are connected."
   scripts/install.sh install watcher
   journalctl --user -u grok-t3-watcher -f
   ```

You can stop here if you only want alerts.

## 2. The gateway's credentials

```bash
grok-t3 pair             # full-access ceiling, so it can answer full-access threads
grok-t3 new-bearer
```

`grok-t3 pair auto` or `grok-t3 pair approval-required` gives a lower ceiling: the gateway then cannot answer threads running in a broader mode. The grant shows up in T3 under Settings → Sharing & access as **grok-bot-setup gateway**.

## 3. Cloudflare

### API token (setup only)

Create a custom API token at dash.cloudflare.com → My Profile → API Tokens with:

| Scope | Permission |
|---|---|
| Account | Cloudflare Tunnel: Edit |
| Account | Access: Apps and Policies: Edit |
| Account | Access: Service Tokens: Edit |
| Account | Access: Organizations, Identity Providers, and Groups: Read |
| Zone (your zone only) | DNS: Edit |
| Zone (your zone only) | Zone: Read |

Save it to a 0600 file. You can delete the token from Cloudflare when setup is done. You only need it again for `teardown`.

### Provision

Pick a hostname nobody would guess, like `t3hook-<random>.example.com`.

```bash
umask 077; cat > ~/cf-token              # paste, Enter, Ctrl-D
CLOUDFLARE_API_TOKEN_FILE=~/cf-token bin/grok-t3-cloudflare provision \
  --zone example.com \
  --hostname t3hook-x7k2.example.com \
  --out ~/.config/grok-bot-setup/handoff
```

This creates the tunnel (locally managed), a proxied CNAME, an Access service token, a Service Auth policy that allows only that token, and an Access app on the hostname. IDs go to `~/.config/grok-bot-setup/cloudflare.json` for teardown. The tunnel credentials, the service token and `access.env` go to the handoff directory, all 0600, never printed.

If your token cannot read the Zero Trust organization, add `--team-domain yourteam.cloudflareaccess.com`.

### Tunnel service (sudo)

```bash
scripts/install-tunnel.sh install \
  --tunnel-id <tunnel id printed above> \
  --hostname t3hook-x7k2.example.com \
  --credentials ~/.config/grok-bot-setup/handoff/tunnel.json
shred -u ~/.config/grok-bot-setup/handoff/tunnel.json
```

This installs `cloudflared` from Cloudflare's signed apt repository if needed, writes `/etc/cloudflared/grok-t3/` (root, 0600), and starts `cloudflared-grok-t3.service` as a sandboxed `DynamicUser`.

## 4. Start the gateway

```bash
cat ~/.config/grok-bot-setup/handoff/access.env >> ~/.config/grok-bot-setup/config.env
scripts/install.sh install gateway
journalctl --user -u grok-t3-gateway -n 5     # "access enforced, read-write"
```

Check from outside that the edge blocks you without the token. Both should print `401`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://t3hook-x7k2.example.com/mcp
curl -s -o /dev/null -w '%{http_code}\n' https://t3hook-x7k2.example.com/anything
```

## 5. Connect the assistant

Add the MCP connector and the answering instructions from [grok-routine.md](grok-routine.md), then shred the handoff file with the service token.

## Updating

```bash
cd ~/Code/grok-bot-setup && git pull && bun install
scripts/install.sh install
systemctl --user restart grok-t3-watcher grok-t3-gateway
```

After a T3 update, run `grok-t3 status`. If it reports a schema problem, alerts are off until this project is updated for the new T3.

## Removing everything

Tear down Cloudflare first: it reads the IDs saved in the config directory, which `--purge` deletes.

```bash
scripts/install-tunnel.sh uninstall
CLOUDFLARE_API_TOKEN_FILE=~/cf-token bin/grok-t3-cloudflare teardown
scripts/install.sh uninstall --purge
```

Then revoke **grok-bot-setup gateway** in T3 (Settings → Sharing & access), delete the routine and the connector in Grok Bot, and delete the Cloudflare API token.
