#!/bin/bash

queries=("Robinhood" "Chime" "Revolut" "Wise" "Klarna" "Afterpay" "Crunchyroll")
total_written=0
total_drive=0

for q in "${queries[@]}"; do
  echo "Ingesting $q..."

  # Try the command
  output=$(npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>/tmp/mobbin_err | npx ts-node src/cli.ts ingest 2>/dev/null)
  status=${PIPESTATUS[0]}

  # Check for 500/504 in error log if status is non-zero
  if [ $status -ne 0 ]; then
    err_msg=$(cat /tmp/mobbin_err)
    if [[ "$err_msg" == *"500"* || "$err_msg" == *"504"* ]]; then
      echo "Encountered 500/504 error for $q. Retrying in 10s..."
      sleep 10
      output=$(npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>/dev/null | npx ts-node src/cli.ts ingest 2>/dev/null)
    else
      echo "Failed to ingest $q: $err_msg"
      continue
    fi
  fi

  # Parse output JSON {"written": X, "driveUploaded": Y}
  written=$(echo $output | jq -r '.written // 0')
  drive=$(echo $output | jq -r '.driveUploaded // 0')

  echo "  Written: $written, Drive: $drive"

  total_written=$((total_written + written))
  total_drive=$((total_drive + drive))
done

echo "--------------------------------"
echo "Summary Batch A:"
echo "Total screens written: $total_written"
echo "Total Drive uploads completed: $total_drive"
