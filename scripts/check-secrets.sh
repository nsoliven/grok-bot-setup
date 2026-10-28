#!/usr/bin/env bash
# Run before every push. Fails on anything that looks like a credential, and on any word in your
# private list (domain, hostnames, LAN addresses, team name...), one per line, kept outside the repo:
#   ~/.config/grok-bot-setup/private-words.txt
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
words="$HOME/.config/grok-bot-setup/private-words.txt"
status=0

if command -v gitleaks >/dev/null; then
  gitleaks git --no-banner --redact "$repo" || status=1
elif command -v docker >/dev/null; then
  docker run --rm -v "$repo:/repo:ro" ghcr.io/gitleaks/gitleaks:latest git --no-banner --redact /repo || status=1
else
  echo "gitleaks not found (install it or Docker); skipping the credential scan." >&2
  status=1
fi

if [[ -s "$words" ]]; then
  # Search tracked files and full history; print file names only, never the matching line.
  while IFS= read -r word; do
    [[ -z "$word" || "$word" == \#* ]] && continue
    if git -C "$repo" grep -lIiF -e "$word" -- . ':!scripts/check-secrets.sh' >/dev/null 2>&1 ||
      [[ -n "$(git -C "$repo" log --all -p -i -F -S "$word" --format=%h 2>/dev/null | head -1)" ]]; then
      echo "private word #$(grep -nxF -- "$word" "$words" | cut -d: -f1) of $words appears in the repo or its history" >&2
      status=1
    fi
  done < "$words"
else
  echo "No private word list at $words; add one so your domain and hostnames can never be published." >&2
  status=1
fi

[[ $status -eq 0 ]] && echo "No secrets or private words found."
exit $status
