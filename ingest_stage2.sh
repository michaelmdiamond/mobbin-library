#!/bin/bash
# Stage 2: Deep per-app pull for every app already in the DB.
# Reads all app names from the DB and runs targeted limit=50 pulls for each.
#
# Usage: bash ingest_stage2.sh [platform] [parallelism] [limit]
#   platform:    ios | web | both (default: both)
#   parallelism: concurrent workers (default: 2)
#   limit:       screens per app (default: 50)

PLATFORM=${1:-both}
PARALLELISM=${2:-2}
LIMIT=${3:-30}  # Mobbin MCP rejects limit > 30
WORK_DIR=$(mktemp -d)

ingest_one() {
  local q="$1"
  local platform="$2"
  local limit="$3"
  local safe_name
  safe_name=$(echo "$q" | tr ' /\\:' '____')
  local out_file="$WORK_DIR/${safe_name}_${platform}.result"

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
    echo "| $q ($platform) | $written | $drive | OK |"
  else
    echo "| $q ($platform) | 0 | 0 | Failed/Empty |"
  fi
}

run_platform() {
  local platform="$1"
  local app_file="$WORK_DIR/apps_${platform}.txt"

  # Get all app names for this platform from DB
  npx ts-node src/cli.ts apps --platform "$platform" 2>/dev/null \
    | node -e "
        const c=[];
        process.stdin.on('data',d=>c.push(d));
        process.stdin.on('end',()=>{
          try{JSON.parse(c.join('')).forEach(r=>console.log(r.appName));}catch(e){}
        });
      " > "$app_file"

  local total
  total=$(wc -l < "$app_file" | tr -d ' ')

  echo ""
  echo "========================================"
  echo " $platform: $total apps (limit=$LIMIT, parallelism=$PARALLELISM)"
  echo "========================================"
  echo "| Query | Written | Drive Uploaded | Status |"
  echo "|-------|---------|----------------|--------|"

  local pids=()
  local count=0

  while IFS= read -r app; do
    [ -z "$app" ] && continue
    ingest_one "$app" "$platform" "$LIMIT" &
    pids+=($!)
    count=$((count + 1))
    sleep 2  # Stagger to stay within Mobbin's concurrent session limit

    if [ "${#pids[@]}" -ge "$PARALLELISM" ]; then
      wait "${pids[0]}"
      pids=("${pids[@]:1}")
    fi
  done < "$app_file"

  for pid in "${pids[@]}"; do wait "$pid"; done

  echo ""
  echo "Done: $count apps processed for $platform."
}

if [[ "$PLATFORM" == "web" || "$PLATFORM" == "both" ]]; then
  run_platform web
fi

if [[ "$PLATFORM" == "ios" || "$PLATFORM" == "both" ]]; then
  run_platform ios
fi

echo ""
echo "========================================"
echo " Final stats"
echo "========================================"
npx ts-node src/cli.ts stats 2>/dev/null

rm -rf "$WORK_DIR"
