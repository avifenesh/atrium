#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

npm install
npm run build

mkdir -p ~/.config/systemd/user
# absolute target — a relative symlink would dangle from ~/.config/systemd/user
ln -sf "$ROOT/scripts/atrium.service" ~/.config/systemd/user/atrium.service
systemctl --user daemon-reload
systemctl --user enable --now atrium.service

echo "open http://127.0.0.1:5599"
echo "register in eigen: node scripts/register-eigen.mjs"
