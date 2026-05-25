#!/bin/bash
# Discovery crawler — pulls as much Mobbin data as possible.
#
# Strategy:
#   Phase 1: Run broad seed queries in parallel to surface app names.
#   Phase 2: For every newly discovered app, run a targeted high-limit pull.
#   Repeat Phase 2 until no new apps are found.
#
# Usage: bash ingest_discover.sh [platform] [parallelism]
#   platform:    ios | web | both  (default: both)
#   parallelism: number of concurrent workers (default: 4)

PLATFORM=${1:-both}
PARALLELISM=${2:-2}   # Mobbin MCP rejects >2 concurrent high-limit sessions
WORK_DIR=$(mktemp -d)

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

# --- helpers ---

get_known_apps() {
  local platform=$1
  npx ts-node src/cli.ts apps --platform "$platform" 2>/dev/null \
    | node -e "
        const c=[];
        process.stdin.on('data',d=>c.push(d));
        process.stdin.on('end',()=>{
          try { JSON.parse(c.join('')).forEach(r=>console.log(r.appName.toLowerCase())); }
          catch(e) {}
        });
      "
}

ingest_query() {
  local q="$1"
  local platform="$2"
  local limit="${3:-30}"
  local mode="${4:-deep}"
  local safe_name
  safe_name=$(echo "${q}_${platform}" | tr ' /\\:' '____')
  local raw_file="$WORK_DIR/raw_${safe_name}.json"
  local disc_file="$WORK_DIR/disc_${safe_name}.txt"
  local out_file="$WORK_DIR/out_${safe_name}.txt"

  npx ts-node src/mobbin-raw.ts search "$q" --platform "$platform" \
    --limit "$limit" --mode "$mode" > "$raw_file" 2>/dev/null

  if [ ! -s "$raw_file" ]; then
    sleep 10
    npx ts-node src/mobbin-raw.ts search "$q" --platform "$platform" \
      --limit "$limit" --mode "$mode" > "$raw_file" 2>/dev/null
  fi

  if [ ! -s "$raw_file" ]; then
    echo "| $q ($platform) | 0 | 0 | Failed/Empty |" > "$out_file"
    return
  fi

  # Ingest
  local result
  result=$(cat "$raw_file" | npx ts-node src/cli.ts ingest 2>/dev/null)
  local written drive
  written=$(echo "$result" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.written??0);}catch(e){console.log(0);}")
  drive=$(echo "$result" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.driveUploaded??0);}catch(e){console.log(0);}")

  echo "| $q ($platform) | $written | $drive | OK |" > "$out_file"

  # Extract discovered app names to a per-job file (safe for parallel writes)
  node -e "
    const fs = require('fs');
    try {
      const screens = JSON.parse(fs.readFileSync('$raw_file', 'utf-8'));
      const names = [...new Set(screens.map(s => s.appName).filter(Boolean))];
      names.forEach(n => console.log(n + '\t$platform'));
    } catch(e) {}
  " > "$disc_file" 2>/dev/null

  rm -f "$raw_file"
}

# Run a list of jobs in parallel; each line of input_file is tab-separated:
#   query <TAB> platform <TAB> limit <TAB> mode
run_parallel() {
  local input_file="$1"
  local result_files=()
  local pids=()

  while IFS=$'\t' read -r q platform limit mode; do
    local safe_name
    safe_name=$(echo "${q}_${platform}" | tr ' /\\:' '____')
    local out_file="$WORK_DIR/out_${safe_name}.txt"
    result_files+=("$out_file")

    ingest_query "$q" "$platform" "${limit:-30}" "${mode:-deep}" &
    pids+=($!)
    sleep 2  # Stagger starts to avoid bursting Mobbin's concurrent session limit

    # Throttle: wait for the oldest job if at capacity
    if [ "${#pids[@]}" -ge "$PARALLELISM" ]; then
      wait "${pids[0]}"
      pids=("${pids[@]:1}")
    fi
  done < "$input_file"

  # Wait for remaining jobs
  for pid in "${pids[@]}"; do
    wait "$pid"
  done

  # Print results in submission order
  for f in "${result_files[@]}"; do
    [ -f "$f" ] && cat "$f"
  done
}

# --- Phase 1: Seed queries ---

echo "========================================"
echo " Phase 1: Seed queries"
echo "========================================"
echo "| Query | Written | Drive Uploaded | Status |"
echo "|-------|---------|----------------|--------|"

SEED_FILE="$WORK_DIR/seeds.txt"
> "$SEED_FILE"

if [[ "$PLATFORM" == "ios" || "$PLATFORM" == "both" ]]; then
  for q in "${IOS_SEEDS[@]}"; do
    printf '%s\tios\t30\tdeep\n' "$q" >> "$SEED_FILE"
  done
fi
if [[ "$PLATFORM" == "web" || "$PLATFORM" == "both" ]]; then
  for q in "${WEB_SEEDS[@]}"; do
    printf '%s\tweb\t30\tdeep\n' "$q" >> "$SEED_FILE"
  done
fi

run_parallel "$SEED_FILE"

# --- Phase 2+: Expand from discovered apps ---

ROUND=1
while true; do
  echo ""
  echo "========================================"
  echo " Phase 2 (round $ROUND): App expansion"
  echo "========================================"

  # Build current known-apps set from DB
  DONE_APPS="$WORK_DIR/done_apps.txt"
  > "$DONE_APPS"
  if [[ "$PLATFORM" == "ios" || "$PLATFORM" == "both" ]]; then
    get_known_apps ios >> "$DONE_APPS"
  fi
  if [[ "$PLATFORM" == "web" || "$PLATFORM" == "both" ]]; then
    get_known_apps web >> "$DONE_APPS"
  fi

  # Merge all per-job discovery files, find apps not yet in DB
  QUEUE="$WORK_DIR/queue_${ROUND}.txt"
  > "$QUEUE"

  cat "$WORK_DIR"/disc_*.txt 2>/dev/null | sort -u | while IFS=$'\t' read -r app platform; do
    lower=$(echo "$app" | tr '[:upper:]' '[:lower:]')
    if ! grep -qxF "$lower" "$DONE_APPS" 2>/dev/null; then
      printf '%s\t%s\t30\tdeep\n' "$app" "$platform" >> "$QUEUE"
    fi
  done

  if [ ! -s "$QUEUE" ]; then
    echo "No new apps discovered. Done."
    break
  fi

  new_count=$(wc -l < "$QUEUE" | tr -d ' ')
  echo "Found $new_count new apps to pull."
  echo "| Query | Written | Drive Uploaded | Status |"
  echo "|-------|---------|----------------|--------|"

  # Remove old discovery files so next round starts fresh
  rm -f "$WORK_DIR"/disc_*.txt

  run_parallel "$QUEUE"

  ROUND=$((ROUND + 1))

  if [ "$ROUND" -gt 10 ]; then
    echo "Reached max expansion rounds (10). Run again to continue."
    break
  fi
done

echo ""
echo "========================================"
echo " Final stats"
echo "========================================"
npx ts-node src/cli.ts stats 2>/dev/null

rm -rf "$WORK_DIR"
