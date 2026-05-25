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
import * as fs from 'fs'
import * as path from 'path'
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
  updateDriveInfo,
  getScreensMissingDrive,
} from './cache'
import type { Platform, UpsertScreenInput } from './types'
import { getClient } from './db'

const [,, command, ...args] = process.argv
const TOKEN_PATH = path.join(__dirname, '..', 'token.json')

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
      printJson(await getStats())
      break
    }

    case 'search': {
      const query = args[args.indexOf('--query') + 1] ?? args[args.indexOf('-q') + 1]
      const platform = (args[args.indexOf('--platform') + 1] ?? args[args.indexOf('-p') + 1]) as Platform | undefined
      const limit = parseInt(args[args.indexOf('--limit') + 1] ?? '20', 10)
      const results = await searchScreens({ query, platform, limit })
      printJson(results.map(stripImage))
      break
    }

    case 'by-query': {
      const query = args[0]
      const platform = (args[args.indexOf('--platform') + 1] ?? args[args.indexOf('-p') + 1]) as Platform | undefined
      if (!query) { console.error('Usage: by-query <query> [--platform ios|web]'); process.exit(1) }
      const results = await searchByQuery(query, platform)
      printJson(results.map(stripImage))
      break
    }

    case 'tags': {
      printJson(await listAllTags())
      break
    }

    case 'apps': {
      const platform = (args[args.indexOf('--platform') + 1] ?? args[args.indexOf('-p') + 1]) as Platform | undefined
      printJson(await listAllApps(platform))
      break
    }

    case 'get': {
      const id = args[0]
      if (!id) { console.error('Usage: get <screen-id>'); process.exit(1) }
      const screen = await getScreen(id)
      if (!screen) { console.error('Not found'); process.exit(1) }
      printJson(stripImage(screen))
      break
    }

    case 'tag': {
      const id = args[0]
      const tags = args.slice(1)
      if (!id || tags.length === 0) { console.error('Usage: tag <screen-id> <tag1> <tag2> ...'); process.exit(1) }
      const result = await addTags(id, tags)
      if (!result) { console.error('Screen not found'); process.exit(1) }
      printJson(stripImage(result))
      break
    }

    case 'note': {
      const id = args[0]
      const note = args.slice(1).join(' ')
      if (!id) { console.error('Usage: note <screen-id> <note text>'); process.exit(1) }
      const result = await updateScreen(id, { notes: note })
      if (!result) { console.error('Screen not found'); process.exit(1) }
      printJson(stripImage(result))
      break
    }

    case 'ingest': {
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
      let driveUploaded = 0
      for (const input of inputs) {
        try {
          await upsertScreen(input)
          written++
          if (fs.existsSync(TOKEN_PATH)) {
            try {
              const { uploadScreenImage } = await import('./drive')
              const result = await uploadScreenImage(input.id, input.appName, input.imageUrl)
              await updateDriveInfo(input.id, result.fileId, result.webViewLink)
              driveUploaded++
            } catch (err) {
              console.error(`Failed to upload screen ${input.id} to Drive:`, err)
            }
          }
        } catch (err) {
          console.error(`Failed to write screen ${input.id}:`, err)
        }
      }
      await logSearch({
        query: inputs[0]?.query ?? 'batch-ingest',
        platform: inputs[0]?.platform ?? 'ios',
        mode: 'deep',
        limit: inputs.length,
        resultCount: inputs.length,
        hitCount: 0,
        searchedAt: new Date().toISOString(),
      })
      console.log(JSON.stringify({ written, driveUploaded }))
      break
    }

    case 'delete': {
      const id = args[0]
      if (!id) { console.error('Usage: delete <screen-id>'); process.exit(1) }
      const ok = await deleteScreen(id)
      console.log(JSON.stringify({ deleted: ok }))
      break
    }

    case 'push-tokens': {
      // Pushes local mobbin-token.json + mobbin-client.json into the Supabase config table
      // so that remote CCR jobs can authenticate with Mobbin without local files.
      const db = getClient()
      const tokenPath = path.join(__dirname, '..', 'mobbin-token.json')
      const clientPath = path.join(__dirname, '..', 'mobbin-client.json')
      if (!fs.existsSync(tokenPath) || !fs.existsSync(clientPath)) {
        console.error('mobbin-token.json or mobbin-client.json not found. Run: npx ts-node src/mobbin-raw.ts login')
        process.exit(1)
      }
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))
      const client = JSON.parse(fs.readFileSync(clientPath, 'utf-8'))
      const now = new Date().toISOString()
      await db.from('config').upsert([
        { key: 'mobbin_token', value: token, updated_at: now },
        { key: 'mobbin_client', value: client, updated_at: now },
      ], { onConflict: 'key' })
      console.log('Mobbin tokens pushed to Supabase.')
      break
    }

    case 'drive-auth': {
      const { authorizeInteractive } = await import('./drive')
      await authorizeInteractive()
      break
    }

    case 'drive-upload': {
      const { uploadScreenImage } = await import('./drive')
      const pending = await getScreensMissingDrive()
      if (pending.length === 0) { console.log('All screens already uploaded to Drive.'); break }
      console.log(`Uploading ${pending.length} screens to Google Drive...`)
      let done = 0
      let failed = 0
      for (const screen of pending) {
        try {
          const result = await uploadScreenImage(screen.id, screen.appName, screen.imageUrl)
          await updateDriveInfo(screen.id, result.fileId, result.webViewLink)
          done++
          if (done % 10 === 0) console.log(`  ${done}/${pending.length}`)
        } catch (err) {
          console.error(`  Failed ${screen.id}: ${(err as Error).message}`)
          failed++
        }
      }
      console.log(JSON.stringify({ uploaded: done, failed }))
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
  drive-auth                         One-time Google Drive OAuth authorization
  drive-upload                       Upload all un-synced screen images to Drive
      `.trim())
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
