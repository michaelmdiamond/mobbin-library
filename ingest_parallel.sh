#!/bin/bash
# Parallel ingest script — runs up to PARALLELISM queries concurrently.
# Usage: bash ingest_parallel.sh [parallelism] [platform] [limit] query1 query2 ...
# Example: bash ingest_parallel.sh 2 web 50 "Stripe" "Square" "Brex"

PARALLELISM=${1:-2}
PLATFORM=${2:-web}
LIMIT=${3:-30}  # Mobbin MCP rejects limit > 30
shift 3

QUERIES=("$@")
WORK_DIR=$(mktemp -d)

ingest_one() {
  local q="$1"
  local platform="$2"
  local limit="$3"
  local out_file="$WORK_DIR/$(echo "$q" | tr ' /\\:' '____').result"

  local output
  output=$(npx ts-node src/mobbin-raw.ts search "$q" --platform "$platform" \
    --limit "$limit" --mode deep 2>/dev/null \
    | npx ts-node src/cli.ts ingest 2>/dev/null)

  if [ -z "$output" ]; then
    sleep 10
    output=$(npx ts-node src/mobbin-raw.ts search "$q" --platform "$platform" \
      --limit "$limit" --mode deep 2>/dev/null \
      | npx ts-node src/cli.ts ingest 2>/dev/null)
  fi

  if [ -n "$output" ]; then
    local written drive
    written=$(echo "$output" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.written??0);}catch(e){console.log(0);}")
    drive=$(echo "$output" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.driveUploaded??0);}catch(e){console.log(0);}")
    echo "$q|$written|$drive|Success" > "$out_file"
  else
    echo "$q|0|0|Failed/Empty" > "$out_file"
  fi
}

echo "Running ${#QUERIES[@]} queries on $PLATFORM (limit=$LIMIT, parallelism=$PARALLELISM)"
echo ""

pids=()
for q in "${QUERIES[@]}"; do
  ingest_one "$q" "$PLATFORM" "$LIMIT" &
  pids+=($!)
  sleep 2  # Stagger to stay within Mobbin's concurrent session limit

  if [ "${#pids[@]}" -ge "$PARALLELISM" ]; then
    wait "${pids[0]}"
    pids=("${pids[@]:1}")
  fi
done
for pid in "${pids[@]}"; do wait "$pid"; done

echo "| Query | Written | Drive Uploaded | Status |"
echo "|-------|---------|----------------|--------|"

total_written=0
total_drive=0

for q in "${QUERIES[@]}"; do
  result_file="$WORK_DIR/$(echo "$q" | tr ' /\\:' '____').result"
  if [ -f "$result_file" ]; then
    IFS='|' read -r rq written drive status < "$result_file"
    echo "| $q | $written | $drive | $status |"
    total_written=$((total_written + written))
    total_drive=$((total_drive + drive))
  else
    echo "| $q | 0 | 0 | No result |"
  fi
done

echo ""
echo "Total written: $total_written | Total Drive uploaded: $total_drive"

rm -rf "$WORK_DIR"
