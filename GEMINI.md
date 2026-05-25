# Mobbin Library - Agent Handoff

## Current State (as of May 22, 2026)
- **Total Screens:** 14,708
- **Platform Split:** 10,162 iOS / 4,546 Web
- **Storage:** SQLite (`mobbin.db`) + Google Drive Sync + Local `images/` directory.
- **Drive Status:** All currently ingested screens are synced to Drive.

## Technical Mandates (STRICT ADHERENCE REQUIRED)
1. **NEVER use native MCP tools for images:** The short URLs returned by the model-native Mobbin MCP tools expire before they can be processed for Drive upload.
2. **USE local scripts ONLY:** Always use the `src/mobbin-raw.ts` and `src/cli.ts` pipeline for searches and ingestion.
3. **Piped Ingestion Pattern:**
   ```bash
   npx ts-node src/mobbin-raw.ts search "QUERY" --platform web --limit 30 --mode deep 2>/dev/null | npx ts-node src/cli.ts ingest 2>/dev/null
   ```
4. **Secrets Management:** `token.json`, `mobbin-token.json`, `credentials.json`, and `mobbin.db` are gitignored. Do NOT commit them.
5. **Hard limit of 30:** Mobbin's MCP API rejects `--limit` values above 30 with `"MCP error"`. Always use `--limit 30` max.
6. **Parallelism cap of 2:** Running more than 2 concurrent `mobbin-raw.ts` processes causes MCP session errors. Always use `--parallelism 2` and a 2s stagger between job starts.
7. **Use background jobs, not xargs:** `xargs -P` with `export -f` fails because env vars like `WORK_DIR` are not passed to subshells. Always use `ingest_one ... &` + `wait` pattern instead.

## Scripts (use these, not one-off commands)
- **`ingest_pipeline.sh`** — Full pipeline: runs discovery sweep then deep per-app pull. Usage: `bash ingest_pipeline.sh [parallelism] [platform]`
- **`ingest_discover.sh`** — Phase 1 only: broad seed queries to surface new app names. Usage: `bash ingest_discover.sh [platform] [parallelism]`
- **`ingest_stage2.sh`** — Phase 2 only: targeted per-app pull for every app already in DB. Usage: `bash ingest_stage2.sh [platform] [parallelism] [limit]`
- **`ingest_parallel.sh`** — Run a specific list of queries in parallel. Usage: `bash ingest_parallel.sh [parallelism] [platform] [limit] "App1" "App2" ...`

## Current State (updated May 24, 2026)
- **Total Screens:** ~16,311 (as of last discover run; stage2 rerun in progress)
- **Platform Split:** ~10,860 iOS / ~5,451 Web
- **Apps discovered:** 801 iOS / 398 Web
- **All scripts use limit=30, parallelism=2 by default** (Mobbin API hard limits)

## Pending Tasks
- **Stage 2 rerun** is currently running (`ingest_stage2.sh both 2 30`) — deep per-app pull for all 1,199 known apps.
- After stage 2 completes, run `ingest_discover.sh both 2` again to catch any new apps Mobbin has added.
- Run `npx ts-node src/cli.ts stats` to check final screen count.

## Useful Commands
- **Check Stats:** `npx ts-node src/cli.ts stats`
- **Manual Upload:** `npx ts-node src/cli.ts drive-upload` (if any local images aren't on Drive)
- **Drive Auth:** `npx ts-node src/cli.ts drive-auth` (if token expires)
