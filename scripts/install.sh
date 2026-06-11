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
systemctl --user daemon-reload
systemctl --user enable --now atrium.service

echo "open http://127.0.0.1:5599"
echo "register in eigen: node scripts/register-eigen.mjs"
