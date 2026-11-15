#!/bin/bash

QUERIES=(
  "Chime bank"
  "Apple TV+"
  "Box"
  "Coda"
  "Craft"
  "Bitbucket"
  "Hotjar"
  "FullStory"
  "Chargebee"
  "Recurly"
  "Paddle"
  "LastPass"
  "1Password"
  "Bitwarden"
  "Grammarly"
  "Eventbrite"
  "Luma"
  "SurveyMonkey"
  "Qualtrics"
  "Harvest"
  "Toggl"
)

get_variation() {
  case "$1" in
    "Chime bank") echo "Chime" ;;
    "Apple TV+") echo "Apple TV" ;;
    "Box") echo "Box.com" ;;
    "Coda") echo "Coda.io" ;;
    "Craft") echo "Craft.do" ;;
    "Bitbucket") echo "Bitbucket.org" ;;
    "Hotjar") echo "Hotjar.com" ;;
    "FullStory") echo "Full Story" ;;
    "Chargebee") echo "Chargebee.com" ;;
    "Recurly") echo "Recurly.com" ;;
    "Paddle") echo "Paddle.com" ;;
    "LastPass") echo "Last Pass" ;;
    "1Password") echo "1password" ;;
    "Bitwarden") echo "Bitwarden Password Manager" ;;
    "Grammarly") echo "Grammarly.com" ;;
    "Eventbrite") echo "Eventbrite.com" ;;
    "Luma") echo "Lu.ma" ;;
    "SurveyMonkey") echo "Survey Monkey" ;;
    "Qualtrics") echo "Qualtrics.com" ;;
    "Harvest") echo "GetHarvest" ;;
    "Toggl") echo "Toggl Track" ;;
    *) echo "$1" ;;
  esac
}

echo "| Query | Status | Written | Variation Used |"
echo "| :--- | :--- | :--- | :--- |"

for q in "${QUERIES[@]}"; do
  # Run search
  RAW_OUT=$(npx ts-node src/mobbin-raw.ts search "$q" --platform web --limit 30 --mode deep 2>/dev/null)

  # Check if RAW_OUT is an empty array or null
  # We use jq to check the length of the array
  COUNT=$(echo "$RAW_OUT" | jq '. | length' 2>/dev/null || echo 0)

  if [ -z "$COUNT" ] || [ "$COUNT" -eq 0 ]; then
    VAR=$(get_variation "$q")
    if [ "$VAR" != "$q" ]; then
      RAW_OUT_VAR=$(npx ts-node src/mobbin-raw.ts search "$VAR" --platform web --limit 30 --mode deep 2>/dev/null)
      COUNT_VAR=$(echo "$RAW_OUT_VAR" | jq '. | length' 2>/dev/null || echo 0)

      if [ -z "$COUNT_VAR" ] || [ "$COUNT_VAR" -eq 0 ]; then
        echo "| $q | Failure | 0 | No ($VAR also 0) |"
      else
        RESULT=$(echo "$RAW_OUT_VAR" | npx ts-node src/cli.ts ingest 2>/dev/null)
        WRITTEN=$(echo "$RESULT" | jq -r '.written' 2>/dev/null || echo 0)
        echo "| $q | Success | $WRITTEN | Yes ($VAR) |"
      fi
    else
      echo "| $q | Failure | 0 | No (No variation) |"
    fi
  else
    RESULT=$(echo "$RAW_OUT" | npx ts-node src/cli.ts ingest 2>/dev/null)
    WRITTEN=$(echo "$RESULT" | jq -r '.written' 2>/dev/null || echo 0)
    echo "| $q | Success | $WRITTEN | No |"
  fi
done
