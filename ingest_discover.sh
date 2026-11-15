#!/bin/bash
# Bounded discovery crawler.
#
# A run samples a small rotating set of discovery queries and drains a durable
# app queue. It never recursively expands until exhaustion: that made scheduled
# runs last for days and overlap their successors.
#
# Usage: bash ingest_discover.sh [platform] [parallelism]

set -uo pipefail

PLATFORM=${1:-both}
PARALLELISM=${2:-2}   # Mobbin MCP rejects >2 concurrent high-limit sessions
WORK_DIR=$(mktemp -d)
STATE_DIR=${INGEST_STATE_DIR:-"$PWD/.ingest-state"}
QUEUE_FILE="$STATE_DIR/queue.tsv"
IN_PROGRESS_FILE="$STATE_DIR/in-progress.tsv"
COMPLETED_FILE="$STATE_DIR/completed.tsv"
SEED_CURSOR_FILE="$STATE_DIR/seed-cursor"
BOOTSTRAP_MARKER="$STATE_DIR/initial-library-queued-$PLATFORM"
MAX_RUN_SECONDS=$(( ${INGEST_MAX_RUN_MINUTES:-90} * 60 ))
QUERY_BUDGET=${INGEST_QUERY_BUDGET:-18}
SEED_QUERIES_PER_RUN=${INGEST_SEED_QUERIES_PER_RUN:-6}
REQUEST_TIMEOUT_SECONDS=${INGEST_REQUEST_TIMEOUT_SECONDS:-120}
WRITE_TIMEOUT_SECONDS=${INGEST_WRITE_TIMEOUT_SECONDS:-180}
RUN_STARTED_AT=$(date +%s)

mkdir -p "$STATE_DIR"
touch "$QUEUE_FILE" "$IN_PROGRESS_FILE" "$COMPLETED_FILE"
trap 'rm -rf "$WORK_DIR"' EXIT

IOS_SEEDS=(
  "onboarding" "login" "signup" "checkout" "payment" "settings" "profile"
  "home screen" "search" "empty state" "notifications" "subscription"
  "fintech" "social" "food delivery" "fitness" "travel" "shopping"
  "streaming" "dating" "productivity" "education" "crypto" "real estate"
  "ride sharing" "grocery" "news" "photo editing"
)

WEB_SEEDS=(
  "onboarding" "login" "signup" "checkout" "payment" "settings" "dashboard"
  "analytics" "crm" "project management" "collaboration" "ecommerce"
  "fintech" "developer tools" "marketing" "customer support" "hr"
  "accounting" "design" "social" "streaming" "education" "healthcare"
  "empty state" "error" "pricing" "landing"
)

elapsed_seconds() {
  echo $(( $(date +%s) - RUN_STARTED_AT ))
}

within_time_budget() {
  [ "$(elapsed_seconds)" -lt "$MAX_RUN_SECONDS" ]
}

# macOS lacks a built-in timeout command. This parent process gives each MCP
# request a wall-clock deadline without adding another runtime dependency.
run_with_timeout() {
  local seconds=$1
  shift
  perl -e '
    my $seconds = shift @ARGV;
    my $pid = fork();
    die "fork failed: $!\n" unless defined $pid;
    if ($pid == 0) { exec @ARGV; exit 127; }
    $SIG{ALRM} = sub {
      kill "TERM", $pid;
      sleep 2;
      kill "KILL", $pid;
      waitpid($pid, 0);
      exit 124;
    };
    alarm $seconds;
    waitpid($pid, 0);
    my $status = $?;
    alarm 0;
    exit 128 + ($status & 127) if $status & 127;
    exit $status >> 8;
  ' "$seconds" "$@"
}

compact_queue() {
  local tmp="$WORK_DIR/queue.compact.tsv"
  awk -F '\t' 'NF >= 2 {
    key = tolower($1) FS $2
    if (!seen[key]++) print $1 FS $2
  }' "$QUEUE_FILE" > "$tmp"
  mv "$tmp" "$QUEUE_FILE"
}

compact_completed() {
  local tmp="$WORK_DIR/completed.compact.tsv"
  awk -F '\t' 'NF >= 3 { rows[tolower($1) FS $2] = $0 }
    END { for (key in rows) print rows[key] }' "$COMPLETED_FILE" > "$tmp"
  mv "$tmp" "$COMPLETED_FILE"
}

recover_in_progress() {
  if [ -s "$IN_PROGRESS_FILE" ]; then
    local recovered
    recovered=$(wc -l < "$IN_PROGRESS_FILE" | tr -d ' ')
    cat "$IN_PROGRESS_FILE" >> "$QUEUE_FILE"
    : > "$IN_PROGRESS_FILE"
    compact_queue
    echo "Recovered $recovered unfinished queue item(s) from an interrupted run."
  fi
}

# Candidate files contain app<TAB>platform. An app is eligible if it is not
# already queued and has not been processed successfully in the last 30 days.
enqueue_candidates() {
  local candidates=$1
  local refresh_cutoff=$(( $(date +%s) - 30 * 24 * 60 * 60 ))
  local additions="$WORK_DIR/queue.additions.tsv"

  [ -s "$candidates" ] || return 0
  awk -F '\t' -v cutoff="$refresh_cutoff" \
    -v completed="$COMPLETED_FILE" -v queue="$QUEUE_FILE" -v progress="$IN_PROGRESS_FILE" \
    'FILENAME == completed && NF >= 3 { done[tolower($1) FS $2] = $3; next }
     (FILENAME == queue || FILENAME == progress) && NF >= 2 { queued[tolower($1) FS $2] = 1; next }
     FILENAME != completed && FILENAME != queue && FILENAME != progress && NF >= 2 {
       app = $1; platform = $2; key = tolower(app) FS platform
       if ((!(key in done) || done[key] <= cutoff) && !(key in queued) && !(key in added)) {
         print app FS platform
         added[key] = 1
       }
     }' "$COMPLETED_FILE" "$QUEUE_FILE" "$IN_PROGRESS_FILE" "$candidates" > "$additions"

  if [ -s "$additions" ]; then
    cat "$additions" >> "$QUEUE_FILE"
    compact_queue
  fi
}

requeue_items() {
  local items=$1
  [ -s "$items" ] || return 0
  cat "$items" >> "$QUEUE_FILE"
  compact_queue
}

flush_completed() {
  local completed_new=$1
  [ -s "$completed_new" ] || return 0
  cat "$completed_new" >> "$COMPLETED_FILE"
  compact_completed
  : > "$completed_new"
}

collect_library_apps() {
  local candidates=$1
  : > "$candidates"
  local platform status=0
  for platform in ios web; do
    if [[ "$PLATFORM" != "both" && "$PLATFORM" != "$platform" ]]; then
      continue
    fi
    npx ts-node src/cli.ts apps --platform "$platform" 2>/dev/null \
      | PLATFORM="$platform" node -e '
          const chunks = [];
          process.stdin.on("data", chunk => chunks.push(chunk));
          process.stdin.on("end", () => {
            try {
              const apps = JSON.parse(Buffer.concat(chunks).toString());
              for (const row of apps) if (row.appName) console.log(`${row.appName}\t${process.env.PLATFORM}`);
            } catch { process.exitCode = 1; }
          });
        ' >> "$candidates"
    [ $? -eq 0 ] || status=1
  done
  return "$status"
}

bootstrap_existing_library() {
  [ -f "$BOOTSTRAP_MARKER" ] && return 0

  echo "Bootstrapping the durable queue from the current library..."
  local candidates="$WORK_DIR/library-apps.tsv"
  if collect_library_apps "$candidates"; then
    enqueue_candidates "$candidates"
    date '+%Y-%m-%dT%H:%M:%S%z' > "$BOOTSTRAP_MARKER"
    echo "Initial queue contains $(wc -l < "$QUEUE_FILE" | tr -d ' ') item(s)."
  else
    echo "Queue bootstrap failed; it will retry on the next run." >&2
  fi
}

refill_due_queue() {
  [ -s "$QUEUE_FILE" ] && return 0
  [ -s "$IN_PROGRESS_FILE" ] && return 0

  echo "Queue is empty; checking the library for app refreshes due after 30 days..."
  local candidates="$WORK_DIR/due-library-apps.tsv"
  if collect_library_apps "$candidates"; then
    enqueue_candidates "$candidates"
    echo "Refill queue contains $(wc -l < "$QUEUE_FILE" | tr -d ' ') due item(s)."
  else
    echo "Queue refresh check failed; it will retry on the next run." >&2
  fi
}

ingest_query() {
  local q="$1"
  local platform="$2"
  local limit="${3:-30}"
  local mode="${4:-deep}"
  local safe_name raw_file disc_file out_file err_file raw_status raw_count result ingest_status written drive
  safe_name=$(echo "${q}_${platform}" | tr ' /\\:' '____')
  raw_file="$WORK_DIR/raw_${safe_name}.json"
  disc_file="$WORK_DIR/disc_${safe_name}.txt"
  out_file="$WORK_DIR/out_${safe_name}.txt"
  err_file="$WORK_DIR/err_${safe_name}.txt"

  run_with_timeout "$REQUEST_TIMEOUT_SECONDS" npx ts-node src/mobbin-raw.ts search "$q" --platform "$platform" \
    --limit "$limit" --mode "$mode" > "$raw_file" 2>"$err_file"
  raw_status=$?
  if [ "$raw_status" -ne 0 ] || [ ! -s "$raw_file" ]; then
    sleep 10
    run_with_timeout "$REQUEST_TIMEOUT_SECONDS" npx ts-node src/mobbin-raw.ts search "$q" --platform "$platform" \
      --limit "$limit" --mode "$mode" > "$raw_file" 2>"$err_file"
    raw_status=$?
  fi
  if [ "$raw_status" -ne 0 ] || [ ! -s "$raw_file" ]; then
    echo "| $q ($platform) | 0 | 0 | Retry |" > "$out_file"
    return 1
  fi

  raw_count=$(node -e '
    const fs = require("fs");
    try { const rows = JSON.parse(fs.readFileSync(0, "utf8")); console.log(Array.isArray(rows) ? rows.length : -1); }
    catch { console.log(-1); }
  ' < "$raw_file")
  if ! [[ "$raw_count" =~ ^[0-9]+$ ]]; then
    echo "| $q ($platform) | 0 | 0 | Retry |" > "$out_file"
    return 1
  fi
  if [ "$raw_count" -eq 0 ]; then
    echo "| $q ($platform) | 0 | 0 | Empty |" > "$out_file"
    return 0
  fi

  result=$(run_with_timeout "$WRITE_TIMEOUT_SECONDS" npx ts-node src/cli.ts ingest < "$raw_file" 2>"$err_file")
  ingest_status=$?
  if [ "$ingest_status" -ne 0 ]; then
    echo "| $q ($platform) | 0 | 0 | Retry |" > "$out_file"
    return 1
  fi
  written=$(echo "$result" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.written??-1);}catch(e){console.log(-1);}")
  drive=$(echo "$result" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.driveUploaded??-1);}catch(e){console.log(-1);}")
  if ! [[ "$written" =~ ^[0-9]+$ ]] || ! [[ "$drive" =~ ^[0-9]+$ ]] || [ "$written" -lt "$raw_count" ]; then
    echo "| $q ($platform) | ${written:-0} | ${drive:-0} | Retry |" > "$out_file"
    return 1
  fi
  echo "| $q ($platform) | $written | $drive | OK |" > "$out_file"

  RAW_FILE="$raw_file" SOURCE_PLATFORM="$platform" node -e '
    const fs = require("fs");
    try {
      const screens = JSON.parse(fs.readFileSync(process.env.RAW_FILE, "utf-8"));
      const names = [...new Set(screens.map(s => s.appName || s.app_name).filter(Boolean))];
      names.forEach(name => console.log(`${name}\t${process.env.SOURCE_PLATFORM}`));
    } catch {}
  ' > "$disc_file" 2>/dev/null
}

run_parallel() {
  local input_file="$1"
  local completed_new="$2"
  local retry_file="$3"
  local deferred_file="$4"
  local result_files=()
  local pids=()
  local attempted=0
  local q platform limit mode safe_name out_file record result_q result_platform f status written drive

  while IFS=$'\t' read -r q platform limit mode; do
    [ -n "$q" ] || continue
    if ! within_time_budget; then
      printf '%s\t%s\n' "$q" "$platform" >> "$deferred_file"
      continue
    fi
    safe_name=$(echo "${q}_${platform}" | tr ' /\\:' '____')
    out_file="$WORK_DIR/out_${safe_name}.txt"
    result_files+=("$q"$'\t'"$platform"$'\t'"$out_file")
    ingest_query "$q" "$platform" "${limit:-30}" "${mode:-deep}" &
    pids+=($!)
    attempted=$((attempted + 1))
    sleep 2
    if [ "${#pids[@]}" -ge "$PARALLELISM" ]; then
      wait "${pids[0]}"
      pids=("${pids[@]:1}")
    fi
  done < "$input_file"

  local pid
  if [ "${#pids[@]}" -gt 0 ]; then
    for pid in "${pids[@]}"; do wait "$pid"; done
  fi

  if [ "${#result_files[@]}" -eq 0 ]; then
    return 0
  fi
  for record in "${result_files[@]}"; do
    IFS=$'\t' read -r result_q result_platform f <<< "$record"
    if [ ! -f "$f" ]; then
      printf '%s\t%s\n' "$result_q" "$result_platform" >> "$retry_file"
      RETRY_COUNT=$((RETRY_COUNT + 1))
      continue
    fi
    cat "$f"
    status=$(awk -F '|' '{gsub(/^ +| +$/, "", $5); print $5}' "$f")
    written=$(awk -F '|' '{gsub(/^ +| +$/, "", $3); print $3}' "$f")
    drive=$(awk -F '|' '{gsub(/^ +| +$/, "", $4); print $4}' "$f")
    case "$status" in
      OK|Empty)
        printf '%s\t%s\t%s\n' "$result_q" "$result_platform" "$(date +%s)" >> "$completed_new"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        [ "$status" = "Empty" ] && EMPTY_COUNT=$((EMPTY_COUNT + 1))
        [[ "$written" =~ ^[0-9]+$ ]] && WRITTEN_COUNT=$((WRITTEN_COUNT + written))
        [[ "$drive" =~ ^[0-9]+$ ]] && DRIVE_COUNT=$((DRIVE_COUNT + drive))
        ;;
      *)
        printf '%s\t%s\n' "$result_q" "$result_platform" >> "$retry_file"
        RETRY_COUNT=$((RETRY_COUNT + 1))
        ;;
    esac
  done
  ATTEMPTED_COUNT=$((ATTEMPTED_COUNT + attempted))
}

SUCCESS_COUNT=0
EMPTY_COUNT=0
RETRY_COUNT=0
WRITTEN_COUNT=0
DRIVE_COUNT=0
ATTEMPTED_COUNT=0

recover_in_progress
bootstrap_existing_library
refill_due_queue

SEED_FILE="$WORK_DIR/seeds.tsv"
: > "$SEED_FILE"
if [[ "$PLATFORM" == "ios" || "$PLATFORM" == "both" ]]; then
  for q in "${IOS_SEEDS[@]}"; do printf '%s\tios\t30\tdeep\n' "$q" >> "$SEED_FILE"; done
fi
if [[ "$PLATFORM" == "web" || "$PLATFORM" == "both" ]]; then
  for q in "${WEB_SEEDS[@]}"; do printf '%s\tweb\t30\tdeep\n' "$q" >> "$SEED_FILE"; done
fi

SEED_BATCH="$WORK_DIR/seed-batch.tsv"
SEED_RETRY="$WORK_DIR/seed-retry.tsv"
SEED_DEFERRED="$WORK_DIR/seed-deferred.tsv"
SEED_COMPLETED="$WORK_DIR/seed-completed.tsv"
: > "$SEED_BATCH"; : > "$SEED_RETRY"; : > "$SEED_DEFERRED"; : > "$SEED_COMPLETED"
seed_total=$(wc -l < "$SEED_FILE" | tr -d ' ')
seed_cursor=0
[ -r "$SEED_CURSOR_FILE" ] && read -r seed_cursor < "$SEED_CURSOR_FILE" || true
case "$seed_cursor" in ''|*[!0-9]*) seed_cursor=0 ;; esac
seed_selected=0
while [ "$seed_selected" -lt "$SEED_QUERIES_PER_RUN" ] && [ "$seed_selected" -lt "$seed_total" ]; do
  seed_line=$(( (seed_cursor + seed_selected) % seed_total + 1 ))
  sed -n "${seed_line}p" "$SEED_FILE" >> "$SEED_BATCH"
  seed_selected=$((seed_selected + 1))
done
printf '%s\n' $(( (seed_cursor + seed_selected) % seed_total )) > "$SEED_CURSOR_FILE"

echo "========================================"
echo " Seed discovery (rotating, max $SEED_QUERIES_PER_RUN)"
echo "========================================"
echo "| Query | Written | Drive Uploaded | Status |"
echo "|-------|---------|----------------|--------|"
run_parallel "$SEED_BATCH" "$SEED_COMPLETED" "$SEED_RETRY" "$SEED_DEFERRED"
flush_completed "$SEED_COMPLETED"
SEED_DISCOVERED="$WORK_DIR/seed-discovered.tsv"
cat "$WORK_DIR"/disc_*.txt 2>/dev/null > "$SEED_DISCOVERED" || true
enqueue_candidates "$SEED_DISCOVERED"
requeue_items "$SEED_RETRY"
requeue_items "$SEED_DEFERRED"

remaining_budget=$((QUERY_BUDGET - seed_selected))
[ "$remaining_budget" -lt 0 ] && remaining_budget=0
QUEUE_BATCH="$WORK_DIR/queue-batch.tsv"
QUEUE_REMAINDER="$WORK_DIR/queue-remainder.tsv"
: > "$QUEUE_BATCH"; : > "$QUEUE_REMAINDER"
if [ "$remaining_budget" -gt 0 ]; then
  awk -v limit="$remaining_budget" -v batch="$QUEUE_BATCH" -v remainder="$QUEUE_REMAINDER" \
    'NR <= limit { print > batch; next } { print > remainder }' "$QUEUE_FILE"
  mv "$QUEUE_REMAINDER" "$QUEUE_FILE"
  cat "$QUEUE_BATCH" > "$IN_PROGRESS_FILE"
fi

if [ -s "$QUEUE_BATCH" ]; then
  QUEUE_RETRY="$WORK_DIR/queue-retry.tsv"
  QUEUE_DEFERRED="$WORK_DIR/queue-deferred.tsv"
  QUEUE_COMPLETED="$WORK_DIR/queue-completed.tsv"
  : > "$QUEUE_RETRY"; : > "$QUEUE_DEFERRED"; : > "$QUEUE_COMPLETED"
  echo ""
  echo "========================================"
  echo " Queue worker (max $remaining_budget app queries)"
  echo "========================================"
  echo "| Query | Written | Drive Uploaded | Status |"
  echo "|-------|---------|----------------|--------|"
  run_parallel "$QUEUE_BATCH" "$QUEUE_COMPLETED" "$QUEUE_RETRY" "$QUEUE_DEFERRED"
  flush_completed "$QUEUE_COMPLETED"
  QUEUE_DISCOVERED="$WORK_DIR/queue-discovered.tsv"
  cat "$WORK_DIR"/disc_*.txt 2>/dev/null > "$QUEUE_DISCOVERED" || true
  enqueue_candidates "$QUEUE_DISCOVERED"
  requeue_items "$QUEUE_RETRY"
  requeue_items "$QUEUE_DEFERRED"
  : > "$IN_PROGRESS_FILE"
fi

echo ""
echo "========================================"
echo " Final stats"
echo "========================================"
npx ts-node src/cli.ts stats 2>/dev/null
echo "Run summary: attempted=$ATTEMPTED_COUNT succeeded=$SUCCESS_COUNT empty=$EMPTY_COUNT retry=$RETRY_COUNT written=$WRITTEN_COUNT drive_uploaded=$DRIVE_COUNT queue_depth=$(wc -l < "$QUEUE_FILE" | tr -d ' ') elapsed_seconds=$(elapsed_seconds)"

# A partial run has safely queued its retries, but launchd should distinguish it
# from a completely successful run.
if [ "$RETRY_COUNT" -gt 0 ]; then exit 2; fi
