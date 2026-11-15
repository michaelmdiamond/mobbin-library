#!/bin/bash
queries=("Drift" "Freshdesk" "Help Scout" "PagerDuty" "OpsGenie" "GitLab" "Bitbucket")

echo "| Query | Written | Drive Uploaded | Status |"
echo "|-------|---------|----------------|--------|"

for q in "${queries[@]}"; do
  # Attempt 1
  # We use a temporary file to capture output and check for errors
  tmp_out=$(mktemp)
  npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>/dev/null | npx ts-node src/cli.ts ingest > "$tmp_out" 2>/dev/null

  output=$(cat "$tmp_out")

  if [ -z "$output" ]; then
      # Potential 500/504 or empty results, retry once after 10s
      sleep 10
      npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>/dev/null | npx ts-node src/cli.ts ingest > "$tmp_out" 2>/dev/null
      output=$(cat "$tmp_out")
  fi

  if [ -n "$output" ]; then
    written=$(echo "$output" | node -e "const fs = require('fs'); try { const data = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(data.written ?? 0); } catch(e) { console.log(0); }")
    drive=$(echo "$output" | node -e "const fs = require('fs'); try { const data = JSON.parse(fs.readFileSync(0, 'utf-8')); console.log(data.driveUploaded ?? 0); } catch(e) { console.log(0); }")
    echo "| $q | $written | $drive | Success |"
  else
    echo "| $q | 0 | 0 | Failed/Empty |"
  fi
  rm "$tmp_out"
done
