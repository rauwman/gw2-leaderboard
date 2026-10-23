#!/bin/sh
# Dumps the leaderboard database to a dated SQL file and keeps the newest KEEP files (default 30).
# For a cron job on the Docker host or an LXC. Needs Node.js, `npm install` in this folder, and an API token:
#   export CLOUDFLARE_API_TOKEN=...   # a token with D1 edit permission (Account > D1 > Edit)
#   export CLOUDFLARE_ACCOUNT_ID=...
#   ./tools/backup.sh /path/to/backups
# The dump is the way back: `npx wrangler d1 execute gw2-leaderboard --remote --file <dump>` into an empty database.
set -eu
cd "$(dirname "$0")/.."
dir="${1:?usage: backup.sh <backup folder>}"
keep="${KEEP:-30}"
mkdir -p "$dir"
file="$dir/gw2-leaderboard-$(date +%Y-%m-%d_%H%M).sql"
# BACKUP_LOCAL=1 dumps the local development database (.wrangler/state) instead, to try the script out.
if [ -n "${BACKUP_LOCAL:-}" ]; then
  npx wrangler d1 export gw2-leaderboard --local --output "$file"
else
  npx wrangler d1 export gw2-leaderboard --remote --output "$file"
fi
[ -s "$file" ] || { echo "backup is empty: $file" >&2; exit 1; }
# Older dumps beyond the newest $keep.
ls -1t "$dir"/gw2-leaderboard-*.sql | tail -n +"$((keep + 1))" | while read -r old; do rm -f "$old"; done
echo "$file"
