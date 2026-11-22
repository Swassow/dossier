#!/usr/bin/env bash
# Starts the Claude subscription bridge with a token kept in
# ~/.config/dossier-bridge/token (made on first run). Prints the values to
# put in Dossier's .env or Settings → AI provider.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
config="${XDG_CONFIG_HOME:-$HOME/.config}/dossier-bridge"
mkdir -p "$config"
chmod 700 "$config"

if [[ ! -s "$config/token" ]]; then
  (umask 077 && openssl rand -hex 24 > "$config/token")
  echo "Made a new bridge token in $config/token"
fi

command -v claude >/dev/null || { echo "Claude Code isn't installed: https://claude.com/claude-code" >&2; exit 1; }

port="${BRIDGE_PORT:-8787}"
echo
echo "Dossier settings (in .env next to compose.yml, or Settings → AI provider):"
echo "  DOSSIER_AI_PROVIDER=anthropic"
echo "  DOSSIER_AI_URL=http://host.docker.internal:$port"
echo "  DOSSIER_AI_KEY=<the token in $config/token>"
echo "  DOSSIER_AI_MODEL=claude-sonnet-5-5"
echo "  DOSSIER_AI_TIMEOUT_SECONDS=600"
echo

BRIDGE_TOKEN="$(cat "$config/token")" BRIDGE_PORT="$port" exec node "$dir/claude-subscription-bridge.mjs"
