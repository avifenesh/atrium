#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

npm install
npm run build

NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"

mkdir -p ~/.config/systemd/user
# generate the unit from the template — a symlinked unit would hardcode one
# machine's node path and silently break on the next nvm upgrade
sed -e "s#__NODE_BIN__#${NODE_BIN}#g" \
    -e "s#__NODE_DIR__#${NODE_DIR}#g" \
    -e "s#__ROOT__#${ROOT}#g" \
    scripts/atrium.service.in > ~/.config/systemd/user/atrium.service
# mention radar: the hourly producer that fills the mentions collector's hits file.
# Pure python, so only __ROOT__ needs substituting (no node path).
sed -e "s#__ROOT__#${ROOT}#g" \
    scripts/mention-radar.service.in > ~/.config/systemd/user/mention-radar.service
install -m 0644 scripts/mention-radar.timer ~/.config/systemd/user/mention-radar.timer
systemctl --user daemon-reload
systemctl --user enable --now atrium.service
systemctl --user enable --now mention-radar.timer

echo "open http://127.0.0.1:5599"
echo "register in eigen: node scripts/register-eigen.mjs"
