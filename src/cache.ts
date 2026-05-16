import * as fs from 'fs'
import * as path from 'path'
import { getDb } from './db'
import type {
  MobbinScreen,
  UpsertScreenInput,
  UpdateScreenInput,
  SearchOptions,
  SearchLogEntry,
  Platform,
  SearchMode,
} from './types'

const IMAGES_DIR = path.join(__dirname, '..', 'images')

function ensureImagesDir(): void {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true })
}

function rowToScreen(row: Record<string, unknown>, queries: string[], tags: string[]): MobbinScreen {
  return {
    id: row.id as string,
    appName: row.app_name as string,
    platform: row.platform as Platform,
    imageUrl: row.image_url as string,
    mobbinUrl: row.mobbin_url as string,
    imagePath: (row.image_path as string | null) ?? null,
    imageData: (row.image_data as Buffer | null) ?? null,
    flowName: (row.flow_name as string | null) ?? null,
    appCategory: (row.app_category as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    rawResponse: JSON.parse(row.raw_response as string),
    cachedAt: row.cached_at as string,
    lastSeenAt: row.last_seen_at as string,
    queries,
    tags,
  }
}

function loadRelations(db: ReturnType<typeof getDb>, id: string): { queries: string[]; tags: string[] } {
  const queries = (db.prepare('SELECT query FROM screen_queries WHERE screen_id = ? ORDER BY added_at').all(id) as { query: string }[]).map(r => r.query)
  const tags = (db.prepare('SELECT tag FROM screen_tags WHERE screen_id = ? ORDER BY added_at').all(id) as { tag: string }[]).map(r => r.tag)
  return { queries, tags }
}

export function upsertScreen(input: UpsertScreenInput): MobbinScreen {
  const db = getDb()
  const now = new Date().toISOString()

  let imagePath: string | null = null
  if (input.imageData) {
    ensureImagesDir()
    const ext = input.imageUrl.includes('.webp') ? 'webp' : 'jpg'
    const filename = `${input.id}.${ext}`
    const fullPath = path.join(IMAGES_DIR, filename)
    fs.writeFileSync(fullPath, input.imageData)
    imagePath = path.join('images', filename)
  }

  const existing = db.prepare('SELECT cached_at FROM screens WHERE id = ?').get(input.id) as { cached_at: string } | undefined

  if (existing) {
    db.prepare(`
      UPDATE screens SET
        app_name     = ?,
        image_url    = ?,
        mobbin_url   = ?,
        flow_name    = COALESCE(?, flow_name),
        app_category = COALESCE(?, app_category),
        raw_response = ?,
        last_seen_at = ?
        ${input.imageData ? ', image_data = ?, image_path = ?' : ''}
      WHERE id = ?
    `).run(
      ...(input.imageData
        ? [input.appName, input.imageUrl, input.mobbinUrl, input.flowName ?? null, input.appCategory ?? null, JSON.stringify(input.rawResponse), now, input.imageData, imagePath, input.id]
        : [input.appName, input.imageUrl, input.mobbinUrl, input.flowName ?? null, input.appCategory ?? null, JSON.stringify(input.rawResponse), now, input.id])
    )
  } else {
    db.prepare(`
      INSERT INTO screens (id, app_name, platform, image_url, mobbin_url, image_path, image_data, flow_name, app_category, raw_response, cached_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.appName,
      input.platform,
      input.imageUrl,
      input.mobbinUrl,
      imagePath,
      input.imageData ?? null,
      input.flowName ?? null,
      input.appCategory ?? null,
      JSON.stringify(input.rawResponse),
      now,
      now,
    )
  }

  db.prepare(`
    INSERT OR IGNORE INTO screen_queries (screen_id, query, added_at) VALUES (?, ?, ?)
  `).run(input.id, input.query, now)

  const row = db.prepare('SELECT * FROM screens WHERE id = ?').get(input.id) as Record<string, unknown>
  const { queries, tags } = loadRelations(db, input.id)
  return rowToScreen(row, queries, tags)
}

export function updateScreen(id: string, input: UpdateScreenInput): MobbinScreen | null {
  const db = getDb()
  const now = new Date().toISOString()

  const existing = db.prepare('SELECT id FROM screens WHERE id = ?').get(id)
  if (!existing) return null

  if (input.notes !== undefined || input.appCategory !== undefined || input.flowName !== undefined) {
    const sets: string[] = []
    const vals: unknown[] = []
    if (input.notes !== undefined) { sets.push('notes = ?'); vals.push(input.notes) }
    if (input.appCategory !== undefined) { sets.push('app_category = ?'); vals.push(input.appCategory) }
    if (input.flowName !== undefined) { sets.push('flow_name = ?'); vals.push(input.flowName) }
    vals.push(id)
    db.prepare(`UPDATE screens SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  if (input.tags !== undefined) {
    db.prepare('DELETE FROM screen_tags WHERE screen_id = ?').run(id)
    const insert = db.prepare('INSERT OR IGNORE INTO screen_tags (screen_id, tag, added_at) VALUES (?, ?, ?)')
    for (const tag of input.tags) {
      insert.run(id, tag.toLowerCase().trim(), now)
    }
  }

  const row = db.prepare('SELECT * FROM screens WHERE id = ?').get(id) as Record<string, unknown>
  const { queries, tags } = loadRelations(db, id)
  return rowToScreen(row, queries, tags)
}

export function addTags(id: string, tags: string[]): MobbinScreen | null {
  const db = getDb()
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT id FROM screens WHERE id = ?').get(id)
  if (!existing) return null
  const insert = db.prepare('INSERT OR IGNORE INTO screen_tags (screen_id, tag, added_at) VALUES (?, ?, ?)')
  for (const tag of tags) insert.run(id, tag.toLowerCase().trim(), now)
  const row = db.prepare('SELECT * FROM screens WHERE id = ?').get(id) as Record<string, unknown>
  const { queries, tags: allTags } = loadRelations(db, id)
  return rowToScreen(row, queries, allTags)
}

export function getScreen(id: string): MobbinScreen | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM screens WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  const { queries, tags } = loadRelations(db, id)
  return rowToScreen(row, queries, tags)
}

export function searchScreens(opts: SearchOptions = {}): MobbinScreen[] {
  const db = getDb()
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.platform) { conditions.push('s.platform = ?'); params.push(opts.platform) }
  if (opts.appName) { conditions.push('s.app_name LIKE ?'); params.push(`%${opts.appName}%`) }

  let sql: string

  if (opts.query) {
    sql = `
      SELECT s.* FROM screens s
      JOIN screens_fts fts ON s.id = fts.id
      WHERE screens_fts MATCH ?
      ${conditions.length ? 'AND ' + conditions.join(' AND ') : ''}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `
    params.unshift(opts.query)
  } else {
    sql = `
      SELECT s.* FROM screens s
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY s.last_seen_at DESC
      LIMIT ? OFFSET ?
    `
  }

  params.push(opts.limit ?? 50, opts.offset ?? 0)

  let rows = db.prepare(sql).all(...params) as Record<string, unknown>[]

  if (opts.tags && opts.tags.length > 0) {
    const tagSet = new Set(opts.tags.map(t => t.toLowerCase().trim()))
    rows = rows.filter(row => {
      const tags = (db.prepare('SELECT tag FROM screen_tags WHERE screen_id = ?').all(row.id as string) as { tag: string }[]).map(r => r.tag)
      return opts.tags!.every(t => tags.includes(t.toLowerCase().trim()))
    })
  }

  return rows.map(row => {
    const { queries, tags } = loadRelations(db, row.id as string)
    return rowToScreen(row, queries, tags)
  })
}

export function searchByQuery(query: string, platform?: Platform): MobbinScreen[] {
  const db = getDb()
  const ids = (db.prepare(`
    SELECT DISTINCT screen_id FROM screen_queries WHERE query = ? ${platform ? 'AND screen_id IN (SELECT id FROM screens WHERE platform = ?)' : ''}
  `).all(...(platform ? [query, platform] : [query])) as { screen_id: string }[]).map(r => r.screen_id)

  return ids.map(id => {
    const row = db.prepare('SELECT * FROM screens WHERE id = ?').get(id) as Record<string, unknown>
    const { queries, tags } = loadRelations(db, id)
    return rowToScreen(row, queries, tags)
  })
}

export function listAllTags(): Array<{ tag: string; count: number }> {
  const db = getDb()
  return db.prepare(`
    SELECT tag, COUNT(*) as count FROM screen_tags GROUP BY tag ORDER BY count DESC
  `).all() as Array<{ tag: string; count: number }>
}

export function listAllApps(platform?: Platform): Array<{ appName: string; count: number }> {
  const db = getDb()
  const sql = platform
    ? 'SELECT app_name, COUNT(*) as count FROM screens WHERE platform = ? GROUP BY app_name ORDER BY count DESC'
    : 'SELECT app_name, COUNT(*) as count FROM screens GROUP BY app_name ORDER BY count DESC'
  return (db.prepare(sql).all(...(platform ? [platform] : [])) as Array<{ app_name: string; count: number }>)
    .map(r => ({ appName: r.app_name, count: r.count }))
}

export function logSearch(entry: Omit<SearchLogEntry, 'id'>): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO search_log (query, platform, mode, limit_count, result_count, hit_count, searched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entry.query, entry.platform, entry.mode, entry.limit, entry.resultCount, entry.hitCount, entry.searchedAt)
}

export function getStats(): {
  totalScreens: number
  totalTags: number
  totalQueries: number
  platforms: Record<string, number>
  topApps: Array<{ appName: string; count: number }>
  topTags: Array<{ tag: string; count: number }>
  recentSearches: number
} {
  const db = getDb()
  const totalScreens = (db.prepare('SELECT COUNT(*) as n FROM screens').get() as { n: number }).n
  const totalTags = (db.prepare('SELECT COUNT(DISTINCT tag) as n FROM screen_tags').get() as { n: number }).n
  const totalQueries = (db.prepare('SELECT COUNT(DISTINCT query) as n FROM screen_queries').get() as { n: number }).n
  const platforms = Object.fromEntries(
    (db.prepare('SELECT platform, COUNT(*) as n FROM screens GROUP BY platform').all() as Array<{ platform: string; n: number }>)
      .map(r => [r.platform, r.n])
  )
  const topApps = listAllApps().slice(0, 10)
  const topTags = listAllTags().slice(0, 20)
  const recentSearches = (db.prepare("SELECT COUNT(*) as n FROM search_log WHERE searched_at > datetime('now', '-7 days')").get() as { n: number }).n
  return { totalScreens, totalTags, totalQueries, platforms, topApps, topTags, recentSearches }
}

export function deleteScreen(id: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT image_path FROM screens WHERE id = ?').get(id) as { image_path: string | null } | undefined
  if (!row) return false
  if (row.image_path) {
    const fullPath = path.join(__dirname, '..', row.image_path)
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath)
  }
  db.prepare('DELETE FROM screens WHERE id = ?').run(id)
  return true
}
