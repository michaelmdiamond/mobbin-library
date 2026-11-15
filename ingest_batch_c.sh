#!/bin/bash
total_written=0
total_drive=0
queries=("Drift" "Freshdesk" "Help Scout" "PagerDuty" "OpsGenie" "GitLab" "Bitbucket")

for q in "${queries[@]}"; do
  echo "Processing: $q"
  # Run the command and capture output
  output=$(npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>/dev/null | npx ts-node src/cli.ts ingest 2>/dev/null)

  # Check if output is empty (might indicate an error)
  if [ -z "$output" ]; then
      # We don't have an easy way to check the specific 500/504 here without more complex piping,
      # but let's assume we might need a retry if it failed.
      echo "No output for $q, retrying after 10s..."
      sleep 10
      output=$(npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>/dev/null | npx ts-node src/cli.ts ingest 2>/dev/null)
  fi

  if [ -n "$output" ]; then
    # Simple JSON parsing with sed if jq is not available, but let's assume jq is fine or use node
    written=$(echo "$output" | node -e "const fs = require('fs'); const out = fs.readFileSync(0, 'utf-8'); try { console.log(JSON.parse(out).written || 0); } catch(e) { console.log(0); }")
    drive=$(echo "$output" | node -e "const fs = require('fs'); const out = fs.readFileSync(0, 'utf-8'); try { console.log(JSON.parse(out).driveUploaded || 0); } catch(e) { console.log(0); }")
    total_written=$((total_written + written))
    total_drive=$((total_drive + drive))
    echo "  $q: written=$written, drive=$drive"
  else
    echo "  $q: Failed or empty output"
  fi
done

echo "---"
echo "Summary:"
echo "Total screens written: $total_written"
echo "Total Drive uploads completed: $total_drive"
