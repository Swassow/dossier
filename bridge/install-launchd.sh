#!/usr/bin/env bash
# macOS: runs the Claude subscription bridge in the background, starts it at
# login and restarts it if it stops. `./bridge/install-launchd.sh uninstall`
# removes it. Logs: ~/Library/Logs/dossier-claude-bridge.log
set -euo pipefail

label="me.dossier.claude-bridge"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/dossier-claude-bridge.log"
domain="gui/$(id -u)"

launchctl bootout "$domain/$label" 2>/dev/null || true

if [[ "${1:-}" == "uninstall" ]]; then
  rm -f "$plist"
  echo "Removed the bridge's login item."
  exit 0
fi

src="$(cd "$(dirname "$0")" && pwd)"
# macOS won't let a background service read ~/Desktop, ~/Documents or
# ~/Downloads, so it runs a copy. Run this again after pulling bridge changes.
dir="${XDG_DATA_HOME:-$HOME/.local/share}/dossier-bridge"
mkdir -p "$dir"
cp "$src/claude-subscription-bridge.mjs" "$src/start.sh" "$dir/"
node="$(command -v node)" || { echo "Node isn't on PATH." >&2; exit 1; }
claude="$(command -v claude)" || { echo "Claude Code isn't on PATH." >&2; exit 1; }
# launchd starts with a bare PATH: give it the folders node and claude are in.
path="$(dirname "$claude"):$(dirname "$node"):/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$dir/start.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$path</string>
    <key>HOME</key><string>$HOME</string>
    <key>CLAUDE_BIN</key><string>$claude</string>
    <key>BRIDGE_PORT</key><string>${BRIDGE_PORT:-8787}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF

launchctl bootstrap "$domain" "$plist"
echo "The bridge now runs in the background and starts at login."
echo "  logs: $log"
echo "  stop: $0 uninstall"
