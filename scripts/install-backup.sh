#!/usr/bin/env bash
set -euo pipefail

# restic backups for local state dirs (itch, atrium, revuto vault, hermes).
# the repo lives on the SAME disk; when an rclone remote named 'drive:' exists
# the unit also mirrors the (already encrypted) repo to google drive after each
# run, which covers disk death too. the restic password must survive this
# machine for the mirror to be restorable — keep a copy in a password manager.

# defaults mirrored in server/src/config.ts paths.resticRepo / resticPasswordFile
REPO="$HOME/backups/restic"
PASS_FILE="$HOME/.config/restic/password"
EXCLUDE_FILE="$HOME/.config/restic/excludes"
RESTIC_BIN="$(command -v restic)" || { echo "restic not installed" >&2; exit 1; }

mkdir -p "$HOME/.config/restic"
# generated once, never printed; restic encrypts the repo with it — losing
# this file loses every backup, so it is part of what a future offsite copies
# -s not -f: an interrupted run can leave a zero-byte file, which would wedge
# here forever; regenerating an empty file can never orphan a repo
if [ ! -s "$PASS_FILE" ]; then
  (umask 077; head -c 32 /dev/urandom | base64 -w0 > "$PASS_FILE")
fi
chmod 600 "$PASS_FILE"

cat > "$EXCLUDE_FILE" <<'EOF'
node_modules
.git
.cache
cache
__pycache__
*.sock
EOF

mkdir -p "$REPO"
chmod 700 "$HOME/backups" "$REPO"

export RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD_FILE="$PASS_FILE"
# cat config is the cheap "is this already a repo" probe — init only when it isn't
if ! restic cat config >/dev/null 2>&1; then
  restic init >/dev/null
fi

mkdir -p ~/.config/systemd/user
# offsite mirror only when an rclone remote named 'drive:' is configured —
# the repo is encrypted at rest, so the remote only ever stores ciphertext.
# the marker file is the freshness signal the atrium backup collector watches.
OFFSITE_LINES=""
RCLONE_BIN="$(command -v rclone || true)"
if [ -n "$RCLONE_BIN" ] && "$RCLONE_BIN" listremotes 2>/dev/null | grep -q '^drive:$'; then
  OFFSITE_LINES="ExecStartPost=/bin/sh -c '${RCLONE_BIN} sync %h/backups/restic drive:backups/restic && touch %h/backups/.last-offsite-sync'"
fi

# restic path resolved at install time, same reasoning as install.sh's node path
cat > ~/.config/systemd/user/restic-backup.service <<EOF
[Unit]
Description=restic backup of local state dirs

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
# restic exit 3 = snapshot saved but some files unreadable; without this the
# second ExecStart (forget/prune) never runs and the unit shows failed
SuccessExitStatus=3
Environment=RESTIC_REPOSITORY=%h/backups/restic
Environment=RESTIC_PASSWORD_FILE=%h/.config/restic/password
ExecStart=${RESTIC_BIN} backup --exclude-file=%h/.config/restic/excludes %h/.config/itch %h/.config/atrium %h/revuto %h/.hermes
ExecStart=${RESTIC_BIN} forget --keep-daily 7 --keep-weekly 4 --prune
${OFFSITE_LINES}
EOF

cat > ~/.config/systemd/user/restic-backup.timer <<'EOF'
[Unit]
Description=daily restic backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now restic-backup.timer

echo "first backup: systemctl --user start restic-backup.service"
echo "verify: restic -r ~/backups/restic --password-file ~/.config/restic/password snapshots"
