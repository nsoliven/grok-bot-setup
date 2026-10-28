#!/usr/bin/env bash
# Installs the watcher as a systemd user service. No sudo needed.
#   scripts/install.sh install
#   scripts/install.sh uninstall [--purge]   (--purge also deletes config, secrets and state)
#   scripts/install.sh status
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_home="$HOME/.config"   # the units use %h/.config, so XDG overrides are not honoured
config_dir="$config_home/grok-bot-setup"
secrets_dir="$config_dir/secrets"
unit_dir="$config_home/systemd/user"
state_dir="$HOME/.local/state/grok-bot-setup"
bun="$(command -v bun || echo "$HOME/.bun/bin/bun")"
units=(grok-t3-watcher)

die() { echo "error: $*" >&2; exit 1; }

require_secret() {
  [[ -s "$secrets_dir/$1" ]] || { echo "  missing secret: $secrets_dir/$1"; return 1; }
}

do_install() {
  [[ "$(uname -s)" == Linux ]] || die "Linux with systemd is required."
  systemctl --user show-environment >/dev/null 2>&1 || die "systemd user manager is not available."
  [[ -x "$bun" ]] || die "Bun is required (https://bun.sh)."
  [[ "$repo$bun" =~ ^[A-Za-z0-9_./-]+$ ]] || die "Clone into a path without spaces or special characters (systemd units embed it)."

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

  if require_secret grok-webhook-url && require_secret grok-webhook-authorization; then
    systemctl --user enable --now grok-t3-watcher.service && echo "watcher: running"
  else
    echo "watcher: installed but not started (add the secrets above)"
  fi

  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]]; then
    echo "Note: services stop when you log out. To keep them running: sudo loginctl enable-linger $USER"
  fi
}

do_uninstall() {
  for unit in "${units[@]}"; do
    systemctl --user disable --now "$unit.service" 2>/dev/null || true
    rm -f "$unit_dir/$unit.service"
  done
  systemctl --user daemon-reload
  [[ "$(readlink -f "$HOME/.local/bin/grok-t3" 2>/dev/null)" == "$repo/bin/grok-t3" ]] && rm -f "$HOME/.local/bin/grok-t3"
  if [[ "${1:-}" == --purge ]]; then
    rm -rf "$config_dir" "$state_dir"
    echo "Removed the watcher, config, secrets and state."
  else
    echo "Removed the watcher. Config and secrets kept in $config_dir (use --purge to delete)."
  fi
}

case "${1:-}" in
  install) do_install ;;
  uninstall) shift; do_uninstall "$@" ;;
  status) systemctl --user --no-pager status "${units[@]/%/.service}" || true ;;
  *) sed -n '2,5p' "$0"; exit 1 ;;
esac
