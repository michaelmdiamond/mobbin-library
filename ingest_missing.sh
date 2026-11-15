#!/bin/bash

queries=(
  "Drift" "Freshdesk" "Help Scout" "PagerDuty" "OpsGenie"
  "Apple TV+" "Chime bank" "Bitbucket" "FullStory" "Chargebee"
  "Recurly" "Paddle" "LastPass" "Bitwarden" "SurveyMonkey" "Qualtrics"
)

echo "| Query | Written | Drive Uploaded | Status |"
echo "|-------|---------|----------------|--------|"

for q in "${queries[@]}"; do
  tmp_out=$(mktemp)
  npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>/dev/null | npx ts-node src/cli.ts ingest > "$tmp_out" 2>/dev/null
  output=$(cat "$tmp_out")

  if [ -z "$output" ]; then
    sleep 10
    npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>/dev/null | npx ts-node src/cli.ts ingest > "$tmp_out" 2>/dev/null
    output=$(cat "$tmp_out")
  fi

  if [ -n "$output" ]; then
    written=$(echo "$output" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.written??0);}catch(e){console.log(0);}")
    drive=$(echo "$output" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.driveUploaded??0);}catch(e){console.log(0);}")
    echo "| $q | $written | $drive | Success |"
  else
    echo "| $q | 0 | 0 | Failed/Empty |"
  fi

  rm "$tmp_out"
  sleep 2
done

echo ""
echo "=== Discovery Sweep ==="
echo "| Query | Written | Drive Uploaded | Status |"
echo "|-------|---------|----------------|--------|"

sweeps=("productivity dashboard" "e-commerce checkout" "social media feed")

for q in "${sweeps[@]}"; do
  tmp_out=$(mktemp)
  npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 50 --mode fast 2>/dev/null | npx ts-node src/cli.ts ingest > "$tmp_out" 2>/dev/null
  output=$(cat "$tmp_out")

  if [ -n "$output" ]; then
    written=$(echo "$output" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.written??0);}catch(e){console.log(0);}")
    drive=$(echo "$output" | node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(0,'utf-8'));console.log(d.driveUploaded??0);}catch(e){console.log(0);}")
    echo "| $q | $written | $drive | Success |"
  else
    echo "| $q | 0 | 0 | Failed/Empty |"
  fi

  rm "$tmp_out"
  sleep 2
done
