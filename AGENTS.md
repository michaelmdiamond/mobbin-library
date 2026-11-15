# Mobbin Library

Local SQLite cache for Mobbin UI screens. Stores screen metadata, image data, user tags, notes, and full raw MCP responses for offline reference and faster future lookups.

## CLI

```bash
npx ts-node src/cli.ts stats
npx ts-node src/cli.ts search --query "onboarding" --platform ios --limit 20
npx ts-node src/cli.ts by-query "login screen" --platform web
npx ts-node src/cli.ts tags
npx ts-node src/cli.ts apps --platform ios
npx ts-node src/cli.ts get <screen-id>
npx ts-node src/cli.ts tag <screen-id> tag1 tag2
npx ts-node src/cli.ts note <screen-id> "note text"
npx ts-node src/cli.ts ingest   # JSON array of UpsertScreenInput on stdin
npx ts-node src/cli.ts delete <screen-id>
```

## Data

- `mobbin.db` — SQLite database (gitignored)
- `images/` — Downloaded screen images keyed by screen ID (gitignored)

## Schema

- `screens` — One row per screen with all metadata + optional image BLOB
- `screen_queries` — Many-to-many: which queries surfaced each screen
- `screen_tags` — User-defined tags per screen
- `screens_fts` — FTS5 virtual table for full-text search across app name, flow, category, notes
- `search_log` — Record of every search performed

## Ingest format

`UpsertScreenInput` (from `src/types.ts`):
```json
{
  "id": "<uuid>",
  "appName": "Airbnb",
  "platform": "ios",
  "imageUrl": "https://...",
  "mobbinUrl": "https://mobbin.com/...",
  "query": "onboarding screen",
  "flowName": "Onboarding",
  "appCategory": "Travel",
  "rawResponse": { ... },
  "imageData": "<Buffer or omit>"
}
```
