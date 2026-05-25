#!/bin/bash
# Full pipeline: discover apps via seed queries, then do a deep per-app pull
# for every app found — on both platforms.
#
# Usage: bash ingest_pipeline.sh [parallelism] [seed_platform]
#   parallelism:    concurrent workers (default: 2 — Mobbin's concurrent session limit)
#   seed_platform:  ios | web | both (default: both)

PARALLELISM=${1:-2}
SEED_PLATFORM=${2:-both}

echo "========================================"
echo " Stage 1: Discovery sweep"
echo "========================================"
bash ingest_discover.sh "$SEED_PLATFORM" "$PARALLELISM"

echo ""
echo "========================================"
echo " Stage 2: Deep per-app pull"
echo "========================================"

# For each platform, get every app the DB now knows about and re-pull it
# with a higher limit to ensure we have as many screens as possible.
for platform in ios web; do
  if [[ "$SEED_PLATFORM" != "both" && "$SEED_PLATFORM" != "$platform" ]]; then
    continue
  fi

  echo ""
  echo "--- $platform apps ---"

  # Get all app names from DB for this platform
  mapfile -t apps < <(
    npx ts-node src/cli.ts apps --platform "$platform" 2>/dev/null \
      | node -e "
          const c = [];
          process.stdin.on('data', d => c.push(d));
          process.stdin.on('end', () => {
            try {
              JSON.parse(c.join('')).forEach(r => console.log(r.appName));
            } catch(e) {}
          });
        "
  )

  if [ "${#apps[@]}" -eq 0 ]; then
    echo "No apps found for $platform."
    continue
  fi

  echo "Pulling ${#apps[@]} apps on $platform (limit=50, parallelism=$PARALLELISM)..."
  echo "| Query | Written | Drive Uploaded | Status |"
  echo "|-------|---------|----------------|--------|"

  bash ingest_parallel.sh "$PARALLELISM" "$platform" 30 "${apps[@]}"
done

echo ""
echo "========================================"
echo " Final stats"
echo "========================================"
npx ts-node src/cli.ts stats 2>/dev/null
