#!/usr/bin/env ts-node
/**
 * Migrates the local SQLite database to Supabase.
 *
 * Usage:
 *   npx ts-node supabase/migrate.ts
 *
 * Reads from mobbin.db, writes to Supabase in batches.
 * Idempotent — uses upsert, safe to re-run.
 */

import 'dotenv/config'
import Database from 'better-sqlite3'
import * as path from 'path'
import { getClient } from '../src/db'

const DB_PATH = path.join(__dirname, '..', 'mobbin.db')
const BATCH_SIZE = 200

async function migrate() {
  const db = new Database(DB_PATH, { readonly: true })
  const supabase = getClient()

  // ── screens ──────────────────────────────────────────────────────────
  const totalScreens = (db.prepare('SELECT COUNT(*) as n FROM screens').get() as { n: number }).n
  console.log(`Migrating ${totalScreens} screens...`)

  let offset = 0
  let screensDone = 0

  while (offset < totalScreens) {
    const rows = db.prepare(`
      SELECT id, app_name, platform, image_url, mobbin_url, image_path,
             drive_file_id, drive_url, flow_name, app_category, notes,
             raw_response, cached_at, last_seen_at
      FROM screens
      ORDER BY cached_at
      LIMIT ${BATCH_SIZE} OFFSET ${offset}
    `).all() as Record<string, unknown>[]

    const batch = rows.map(r => ({
      id:            r.id as string,
      app_name:      r.app_name as string,
      platform:      r.platform as string,
      image_url:     r.image_url as string,
      mobbin_url:    r.mobbin_url as string,
      image_path:    (r.image_path as string | null) ?? null,
      drive_file_id: (r.drive_file_id as string | null) ?? null,
      drive_url:     (r.drive_url as string | null) ?? null,
      flow_name:     (r.flow_name as string | null) ?? null,
      app_category:  (r.app_category as string | null) ?? null,
      notes:         (r.notes as string | null) ?? null,
      raw_response:  (() => {
        const v = r.raw_response
        if (!v) return {}
        if (typeof v === 'string') { try { return JSON.parse(v) } catch { return {} } }
        return v
      })(),
      cached_at:     r.cached_at as string,
      last_seen_at:  r.last_seen_at as string,
    }))

    const { error } = await supabase.from('screens').upsert(batch, {
      onConflict: 'id',
      ignoreDuplicates: false,
    })

    if (error) {
      console.error(`screens batch at offset ${offset} failed:`, error.message)
      process.exit(1)
    }

    screensDone += rows.length
    offset += BATCH_SIZE
    process.stdout.write(`\r  screens: ${screensDone}/${totalScreens}`)
  }
  console.log()

  // ── screen_queries ────────────────────────────────────────────────────
  const totalQueries = (db.prepare('SELECT COUNT(*) as n FROM screen_queries').get() as { n: number }).n
  console.log(`Migrating ${totalQueries} screen_queries rows...`)

  offset = 0
  let queriesDone = 0

  while (offset < totalQueries) {
    const rows = db.prepare(`
      SELECT screen_id, query, added_at
      FROM screen_queries
      ORDER BY added_at
      LIMIT ${BATCH_SIZE} OFFSET ${offset}
    `).all() as { screen_id: string; query: string; added_at: string }[]

    const { error } = await supabase.from('screen_queries').upsert(rows, {
      onConflict: 'screen_id,query',
      ignoreDuplicates: true,
    })

    if (error) {
      console.error(`screen_queries batch at offset ${offset} failed:`, error.message)
      process.exit(1)
    }

    queriesDone += rows.length
    offset += BATCH_SIZE
    process.stdout.write(`\r  screen_queries: ${queriesDone}/${totalQueries}`)
  }
  console.log()

  // ── screen_tags ───────────────────────────────────────────────────────
  const totalTags = (db.prepare('SELECT COUNT(*) as n FROM screen_tags').get() as { n: number }).n
  console.log(`Migrating ${totalTags} screen_tags rows...`)

  offset = 0
  let tagsDone = 0

  while (offset < totalTags) {
    const rows = db.prepare(`
      SELECT screen_id, tag, added_at
      FROM screen_tags
      ORDER BY added_at
      LIMIT ${BATCH_SIZE} OFFSET ${offset}
    `).all() as { screen_id: string; tag: string; added_at: string }[]

    const { error } = await supabase.from('screen_tags').upsert(rows, {
      onConflict: 'screen_id,tag',
      ignoreDuplicates: true,
    })

    if (error) {
      console.error(`screen_tags batch at offset ${offset} failed:`, error.message)
      process.exit(1)
    }

    tagsDone += rows.length
    offset += BATCH_SIZE
    process.stdout.write(`\r  screen_tags: ${tagsDone}/${totalTags}`)
  }
  console.log()

  // ── search_log ────────────────────────────────────────────────────────
  const totalLog = (db.prepare('SELECT COUNT(*) as n FROM search_log').get() as { n: number }).n
  console.log(`Migrating ${totalLog} search_log rows...`)

  offset = 0
  let logDone = 0

  while (offset < totalLog) {
    const rows = db.prepare(`
      SELECT query, platform, mode, limit_count, result_count, hit_count, searched_at
      FROM search_log
      ORDER BY searched_at
      LIMIT ${BATCH_SIZE} OFFSET ${offset}
    `).all() as { query: string; platform: string; mode: string; limit_count: number; result_count: number; hit_count: number; searched_at: string }[]

    const { error } = await supabase.from('search_log').insert(rows)

    if (error) {
      // search_log has no unique key — skip duplicates gracefully
      console.warn(`  search_log batch at offset ${offset}: ${error.message}`)
    }

    logDone += rows.length
    offset += BATCH_SIZE
    process.stdout.write(`\r  search_log: ${logDone}/${totalLog}`)
  }
  console.log()

  db.close()
  console.log('\nMigration complete.')
}

migrate().catch((e) => { console.error(e); process.exit(1) })
