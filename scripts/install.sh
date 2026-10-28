#!/usr/bin/env bash
# Installs the watcher and gateway as systemd user services. No sudo needed.
#   scripts/install.sh install [watcher] [gateway]   (default: both)
#   scripts/install.sh uninstall [--purge]           (--purge also deletes config, secrets and state)
#   scripts/install.sh status
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
config_dir="$config_home/grok-bot-setup"
secrets_dir="$config_dir/secrets"
unit_dir="$config_home/systemd/user"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/grok-bot-setup"
bun="$(command -v bun || echo "$HOME/.bun/bin/bun")"
units=(grok-t3-watcher grok-t3-gateway)

die() { echo "error: $*" >&2; exit 1; }

require_secret() {
  [[ -s "$secrets_dir/$1" ]] || { echo "  missing secret: $secrets_dir/$1"; return 1; }
}

install() {
  [[ "$(uname -s)" == Linux ]] || die "Linux with systemd is required."
  systemctl --user show-environment >/dev/null 2>&1 || die "systemd user manager is not available."
  [[ -x "$bun" ]] || die "Bun is required (https://bun.sh)."

  local wanted=("$@"); [[ ${#wanted[@]} -gt 0 ]] || wanted=(watcher gateway)

  (cd "$repo" && "$bun" install --frozen-lockfile --production >/dev/null)

  install -d -m 700 "$config_dir" "$secrets_dir"
  if [[ ! -f "$config_dir/config.env" ]]; then
    install -m 600 "$repo/config/config.example.env" "$config_dir/config.env"
    echo "Created $config_dir/config.env (edit it, then rerun install)."
  fi
  chmod 700 "$config_dir" "$secrets_dir"

  install -d "$unit_dir"
  for unit in "${units[@]}"; do
    sed -e "s|@REPO@|$repo|g" -e "s|@BUN@|$bun|g" "$repo/deploy/systemd/user/$unit.service" > "$unit_dir/$unit.service"
  done
  systemctl --user daemon-reload

  install -d "$HOME/.local/bin"
  ln -sf "$repo/bin/grok-t3" "$HOME/.local/bin/grok-t3"

  for component in "${wanted[@]}"; do
    case "$component" in
      watcher)
        if require_secret grok-webhook-url && require_secret grok-webhook-authorization; then
          systemctl --user enable --now grok-t3-watcher.service && echo "watcher: running"
        else
          echo "watcher: installed but not started (add the secrets above)"
        fi ;;
      gateway)
        if ! grep -Eq '^ACCESS_AUD=.+' "$config_dir/config.env"; then
          echo "gateway: installed but not started (set ACCESS_TEAM_DOMAIN and ACCESS_AUD in config.env first)"
        elif require_secret gateway-bearer && require_secret t3-mcp-token; then
          systemctl --user enable --now grok-t3-gateway.service && echo "gateway: running"
        else
          echo "gateway: installed but not started (run: grok-t3 new-bearer && grok-t3 pair)"
        fi ;;
      *) die "unknown component: $component" ;;
    esac
  done

  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]]; then
    echo "Note: services stop when you log out. To keep them running: sudo loginctl enable-linger $USER"
  fi
}

uninstall() {
  for unit in "${units[@]}"; do
    systemctl --user disable --now "$unit.service" 2>/dev/null || true
    rm -f "$unit_dir/$unit.service"
  done
  systemctl --user daemon-reload
  [[ "$(readlink -f "$HOME/.local/bin/grok-t3" 2>/dev/null)" == "$repo/bin/grok-t3" ]] && rm -f "$HOME/.local/bin/grok-t3"
  if [[ "${1:-}" == --purge ]]; then
    rm -rf "$config_dir" "$state_dir"
    echo "Removed services, config, secrets and state. Also revoke the T3 grant in Settings > Sharing & access."
  else
    echo "Removed services. Config and secrets kept in $config_dir (use --purge to delete)."
  fi
}

case "${1:-}" in
  install) shift; install "$@" ;;
  uninstall) shift; uninstall "$@" ;;
  status) systemctl --user --no-pager status "${units[@]/%/.service}" || true ;;
  *) sed -n '2,5p' "$0"; exit 1 ;;
esac
