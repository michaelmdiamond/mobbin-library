#!/bin/bash
# Wrapper invoked by launchd (com.michaelmdiamond.mobbin-ingest) to keep the
# library current. Runs the discovery crawler, which refreshes the Mobbin auth
# token automatically (see getToken() in src/mobbin-raw.ts) and pulls new
# screens for both platforms.
#
# Run manually with:  bash ingest_scheduled.sh [platform] [parallelism]

set -euo pipefail

# launchd provides only a minimal PATH; ensure Homebrew node/npx are found by
# this script and every `npx ts-node` / `node -e` it spawns.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_DIR="/Users/michael/GitHub/mobbin-library"
cd "$REPO_DIR" || exit 1

PLATFORM="${1:-both}"
PARALLELISM="${2:-2}"
STATE_DIR="${INGEST_STATE_DIR:-$REPO_DIR/.ingest-state}"
LOCK_DIR="$STATE_DIR/run.lock"

mkdir -p "$STATE_DIR"

# launchd will start the next calendar run even when a prior crawl is still
# alive. A directory is an atomic lock on macOS filesystems.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  existing_pid=""
  [ -r "$LOCK_DIR/pid" ] && read -r existing_pid < "$LOCK_DIR/pid" || true
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "mobbin ingest skipped: run already active (pid $existing_pid)"
    exit 0
  fi
  echo "mobbin ingest found a stale lock; recovering it."
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi

printf '%s\n' "$$" > "$LOCK_DIR/pid"
date '+%Y-%m-%dT%H:%M:%S%z' > "$LOCK_DIR/started_at"
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

# These may be overridden for a manual run without changing the scheduler.
export INGEST_STATE_DIR="$STATE_DIR"
export INGEST_MAX_RUN_MINUTES="${INGEST_MAX_RUN_MINUTES:-90}"
export INGEST_QUERY_BUDGET="${INGEST_QUERY_BUDGET:-18}"
export INGEST_SEED_QUERIES_PER_RUN="${INGEST_SEED_QUERIES_PER_RUN:-6}"
export INGEST_REQUEST_TIMEOUT_SECONDS="${INGEST_REQUEST_TIMEOUT_SECONDS:-120}"
export INGEST_WRITE_TIMEOUT_SECONDS="${INGEST_WRITE_TIMEOUT_SECONDS:-180}"

echo "===================================================================="
echo " mobbin ingest run starting: $(date '+%Y-%m-%d %H:%M:%S %z')"
echo " platform=$PLATFORM parallelism=$PARALLELISM"
echo "===================================================================="

set +e
bash "$REPO_DIR/ingest_discover.sh" "$PLATFORM" "$PARALLELISM"
status=$?
set -e

echo "===================================================================="
echo " mobbin ingest run finished: $(date '+%Y-%m-%d %H:%M:%S %z') (exit $status)"
echo "===================================================================="
exit $status
