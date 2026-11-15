#!/bin/bash

queries=("Peacock" "Paramount+" "Apple TV+" "Medium" "Substack" "SoundCloud" "Pandora" "Dropbox")

echo "| Query | Written | Drive Uploaded | Status |"
echo "|-------|---------|----------------|--------|"

for q in "${queries[@]}"; do
  retry=0
  while [ $retry -lt 2 ]; do
    # Run the command and capture output and stderr
    tmp_err=$(mktemp)
    output=$(npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>$tmp_err | npx ts-node src/cli.ts ingest 2>/dev/null)
    exit_code=${PIPESTATUS[0]} # Get exit code of the first command in pipe

    err_content=$(cat $tmp_err)
    rm $tmp_err

    if [ $exit_code -eq 0 ] && [ ! -z "$output" ]; then
      written=$(echo "$output" | jq -r '.written // 0')
      uploaded=$(echo "$output" | jq -r '.driveUploaded // 0')
      echo "| $q | $written | $uploaded | Success |"
      break
    else
      # Check for 500 or 504 in stderr
      if [[ "$err_content" == *"500"* ]] || [[ "$err_content" == *"504"* ]]; then
        if [ $retry -eq 0 ]; then
          sleep 10
          retry=1
          continue
        fi
      fi

      # If not 500/504 or already retried
      echo "| $q | 0 | 0 | Failed (Code: $exit_code) |"
      break
    fi
  done
done
