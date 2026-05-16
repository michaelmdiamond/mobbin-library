#!/usr/bin/env node
/**
 * CLI for reading and writing the Mobbin cache.
 *
 * Usage:
 *   npx ts-node src/cli.ts stats
 *   npx ts-node src/cli.ts search --query "onboarding" --platform ios
 *   npx ts-node src/cli.ts by-query "login screen" --platform ios
 *   npx ts-node src/cli.ts tags
 *   npx ts-node src/cli.ts apps --platform web
 *   npx ts-node src/cli.ts get <screen-id>
 *   npx ts-node src/cli.ts tag <screen-id> <tag1> <tag2> ...
 *   npx ts-node src/cli.ts note <screen-id> "my note"
 *   npx ts-node src/cli.ts ingest   # reads JSON from stdin, writes to cache
 *   npx ts-node src/cli.ts delete <screen-id>
 */

import * as readline from 'readline'
import {
  getStats,
  searchScreens,
  searchByQuery,
  listAllTags,
  listAllApps,
  getScreen,
  addTags,
  updateScreen,
  upsertScreen,
  deleteScreen,
  logSearch,
} from './cache'
import type { Platform, UpsertScreenInput } from './types'

const [,, command, ...args] = process.argv

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, (_, v) => v instanceof Buffer ? '<binary>' : v, 2))
}

function stripImage(screen: unknown): unknown {
  if (typeof screen !== 'object' || !screen) return screen
  const { imageData: _, ...rest } = screen as Record<string, unknown>
  return rest
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', (line) => { data += line + '\n' })
    rl.on('close', () => resolve(data))
  })
}

async function main(): Promise<void> {
  switch (command) {
    case 'stats': {
      printJson(getStats())
      break
    }

    case 'search': {
      const query = args[args.indexOf('--query') + 1] ?? args[args.indexOf('-q') + 1]
      const platform = (args[args.indexOf('--platform') + 1] ?? args[args.indexOf('-p') + 1]) as Platform | undefined
      const limit = parseInt(args[args.indexOf('--limit') + 1] ?? '20', 10)
      const results = searchScreens({ query, platform, limit })
      printJson(results.map(stripImage))
      break
    }

    case 'by-query': {
      const query = args[0]
      const platform = (args[args.indexOf('--platform') + 1] ?? args[args.indexOf('-p') + 1]) as Platform | undefined
      if (!query) { console.error('Usage: by-query <query> [--platform ios|web]'); process.exit(1) }
      const results = searchByQuery(query, platform)
      printJson(results.map(stripImage))
      break
    }

    case 'tags': {
      printJson(listAllTags())
      break
    }

    case 'apps': {
      const platform = (args[args.indexOf('--platform') + 1] ?? args[args.indexOf('-p') + 1]) as Platform | undefined
      printJson(listAllApps(platform))
      break
    }

    case 'get': {
      const id = args[0]
      if (!id) { console.error('Usage: get <screen-id>'); process.exit(1) }
      const screen = getScreen(id)
      if (!screen) { console.error('Not found'); process.exit(1) }
      printJson(stripImage(screen))
      break
    }

    case 'tag': {
      const id = args[0]
      const tags = args.slice(1)
      if (!id || tags.length === 0) { console.error('Usage: tag <screen-id> <tag1> <tag2> ...'); process.exit(1) }
      const result = addTags(id, tags)
      if (!result) { console.error('Screen not found'); process.exit(1) }
      printJson(stripImage(result))
      break
    }

    case 'note': {
      const id = args[0]
      const note = args.slice(1).join(' ')
      if (!id) { console.error('Usage: note <screen-id> <note text>'); process.exit(1) }
      const result = updateScreen(id, { notes: note })
      if (!result) { console.error('Screen not found'); process.exit(1) }
      printJson(stripImage(result))
      break
    }

    case 'ingest': {
      // Reads a JSON array of UpsertScreenInput from stdin and writes each to the cache.
      // Designed to be piped from a Claude Code session after a Mobbin MCP search.
      const raw = await readStdin()
      let inputs: UpsertScreenInput[]
      try {
        const parsed = JSON.parse(raw)
        inputs = Array.isArray(parsed) ? parsed : [parsed]
      } catch (e) {
        console.error('Invalid JSON on stdin')
        process.exit(1)
      }
      let written = 0
      for (const input of inputs) {
        try {
          upsertScreen(input)
          written++
        } catch (err) {
          console.error(`Failed to write screen ${input.id}:`, err)
        }
      }
      logSearch({
        query: inputs[0]?.query ?? 'batch-ingest',
        platform: inputs[0]?.platform ?? 'ios',
        mode: 'deep',
        limit: inputs.length,
        resultCount: inputs.length,
        hitCount: 0,
        searchedAt: new Date().toISOString(),
      })
      console.log(JSON.stringify({ written }))
      break
    }

    case 'delete': {
      const id = args[0]
      if (!id) { console.error('Usage: delete <screen-id>'); process.exit(1) }
      const ok = deleteScreen(id)
      console.log(JSON.stringify({ deleted: ok }))
      break
    }

    default: {
      console.log(`
Commands:
  stats                              Overall library statistics
  search [--query <q>] [--platform ios|web] [--limit n]
  by-query <query> [--platform ios|web]  All cached results for an exact query
  tags                               All tags with usage counts
  apps [--platform ios|web]          All apps with screen counts
  get <screen-id>                    Full record for one screen
  tag <screen-id> <tag1> ...         Add tags to a screen
  note <screen-id> <text>            Set notes on a screen
  ingest                             Read JSON from stdin and write to cache
  delete <screen-id>                 Remove a screen from the cache
      `.trim())
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
