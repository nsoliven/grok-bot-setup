#!/usr/bin/env bash
# Installs cloudflared (Cloudflare's signed apt repo) and a hardened system service that routes
# exactly one hostname's /mcp path to the gateway on 127.0.0.1. Needs sudo.
#   scripts/install-tunnel.sh install --tunnel-id ID --hostname HOST --credentials FILE [--port 47731]
#   scripts/install-tunnel.sh uninstall
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
etc=/etc/cloudflared/grok-t3
unit=cloudflared-grok-t3.service

die() { echo "error: $*" >&2; exit 1; }

install_cloudflared() {
  command -v cloudflared >/dev/null && return
  [[ -f /etc/debian_version ]] || die "Install cloudflared yourself on non-Debian systems, then rerun."
  sudo install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" |
    sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq cloudflared
}

install() {
  local tunnel_id="" hostname="" credentials="" port=47731
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tunnel-id) tunnel_id="$2"; shift 2 ;;
      --hostname) hostname="$2"; shift 2 ;;
      --credentials) credentials="$2"; shift 2 ;;
      --port) port="$2"; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  [[ "$tunnel_id" =~ ^[0-9a-f-]{36}$ ]] || die "--tunnel-id must be a tunnel UUID."
  [[ "$hostname" =~ ^[a-z0-9.-]+$ ]] || die "--hostname looks wrong."
  [[ "$port" =~ ^[0-9]+$ ]] || die "--port must be a number."
  [[ -s "$credentials" ]] || die "--credentials must point at the tunnel credentials JSON."

  install_cloudflared

  sudo install -d -m 0700 -o root -g root "$etc"
  sudo install -m 0600 -o root -g root "$credentials" "$etc/tunnel.json"
  sed -e "s|TUNNEL_ID|$tunnel_id|" -e "s|HOSTNAME|$hostname|" -e "s|GATEWAY_PORT|$port|" \
    "$repo/deploy/cloudflared/config.example.yml" | sudo tee "$etc/config.yml" >/dev/null
  sudo chmod 0600 "$etc/config.yml"
  sudo install -m 0644 "$repo/deploy/systemd/system/$unit" "/etc/systemd/system/$unit"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$unit"
  sudo systemctl --no-pager --lines=5 status "$unit" || true
}

uninstall() {
  sudo systemctl disable --now "$unit" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$unit"
  sudo rm -rf "$etc"
  sudo systemctl daemon-reload
  echo "Tunnel service removed. Delete the Cloudflare side with: bin/grok-t3-cloudflare teardown"
}

case "${1:-}" in
  install) shift; install "$@" ;;
  uninstall) uninstall ;;
  *) sed -n '2,5p' "$0"; exit 1 ;;
esac
