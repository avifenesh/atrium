#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

npm install
npm run build

NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
ATRIUM_UID="$(id -u)"
ATRIUM_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${ATRIUM_UID}}"
ATRIUM_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${ATRIUM_RUNTIME_DIR}/bus}"

systemctl_user() {
  env XDG_RUNTIME_DIR="$ATRIUM_RUNTIME_DIR" \
      DBUS_SESSION_BUS_ADDRESS="$ATRIUM_BUS_ADDRESS" \
      systemctl --user "$@"
}

mkdir -p ~/.config/systemd/user
# generate the unit from the template — a symlinked unit would hardcode one
# machine's node path and silently break on the next nvm upgrade
sed -e "s#__NODE_BIN__#${NODE_BIN}#g" \
    -e "s#__NODE_DIR__#${NODE_DIR}#g" \
    -e "s#__ROOT__#${ROOT}#g" \
    scripts/atrium.service.in > ~/.config/systemd/user/atrium.service
sed -e "s#__NODE_BIN__#${NODE_BIN}#g" \
    -e "s#__NODE_DIR__#${NODE_DIR}#g" \
    -e "s#__ROOT__#${ROOT}#g" \
    scripts/atrium-reentry-agent.service.in > ~/.config/systemd/user/atrium-reentry-agent.service
install -m 0644 scripts/atrium-reentry-agent.timer ~/.config/systemd/user/atrium-reentry-agent.timer

# A deliberately isolated OpenCode project: no repository instructions or source
# tree are loaded, and the custom agent denies every tool.
mkdir -p \
  ~/.config/atrium/reentry-agent/.opencode/agents \
  ~/.config/atrium/reentry-agent/xdg-data/opencode \
  ~/.config/atrium/reentry-agent/xdg-cache \
  ~/.config/atrium/reentry-agent/xdg-state \
  ~/.local/bin
chmod 0700 \
  ~/.config/atrium \
  ~/.config/atrium/reentry-agent \
  ~/.config/atrium/reentry-agent/.opencode \
  ~/.config/atrium/reentry-agent/xdg-data \
  ~/.config/atrium/reentry-agent/xdg-data/opencode \
  ~/.config/atrium/reentry-agent/xdg-cache \
  ~/.config/atrium/reentry-agent/xdg-state
install -m 0600 scripts/reentry-agent/opencode.json ~/.config/atrium/reentry-agent/opencode.json
install -m 0600 scripts/reentry-agent/reentry-status.md ~/.config/atrium/reentry-agent/.opencode/agents/reentry-status.md
install -m 0755 scripts/atrium-reentry.mjs ~/.local/bin/atrium-reentry
ATRIUM_OPENCODE_AUTH=~/.config/atrium/reentry-agent/xdg-data/opencode/auth.json
if [[ -f ~/.local/share/opencode/auth.json ]]; then
  if [[ -e "$ATRIUM_OPENCODE_AUTH" && ! -L "$ATRIUM_OPENCODE_AUTH" ]]; then
    echo "refusing to replace non-symlink $ATRIUM_OPENCODE_AUTH" >&2
    exit 1
  fi
  ln -sfn ~/.local/share/opencode/auth.json "$ATRIUM_OPENCODE_AUTH"
fi
# mention radar: the hourly producer that fills the mentions collector's hits file.
# Pure python, so only __ROOT__ needs substituting (no node path).
sed -e "s#__ROOT__#${ROOT}#g" \
    scripts/mention-radar.service.in > ~/.config/systemd/user/mention-radar.service
install -m 0644 scripts/mention-radar.timer ~/.config/systemd/user/mention-radar.timer
systemctl_user daemon-reload
systemctl_user enable atrium.service
# enable --now is a no-op when the daemon is already active; restart so this
# installation always serves the bundle and server code that were just built.
systemctl_user restart atrium.service
systemctl_user enable --now atrium-reentry-agent.timer
systemctl_user enable --now mention-radar.timer

echo "open http://127.0.0.1:5599"
echo "register in eigen: node scripts/register-eigen.mjs"
