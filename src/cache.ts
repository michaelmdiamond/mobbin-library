import * as fs from 'fs'
import * as path from 'path'
import { getClient } from './db'
import type {
  MobbinScreen,
  UpsertScreenInput,
  UpdateScreenInput,
  SearchOptions,
  SearchLogEntry,
  Platform,
} from './types'

const IMAGES_DIR = path.join(__dirname, '..', 'images')

function ensureImagesDir(): void {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true })
}

function rowToScreen(
  row: Record<string, unknown>,
  queries: string[],
  tags: string[],
): MobbinScreen {
  return {
    id: row.id as string,
    appName: row.app_name as string,
    platform: row.platform as Platform,
    imageUrl: row.image_url as string,
    mobbinUrl: row.mobbin_url as string,
    imagePath: (row.image_path as string | null) ?? null,
    imageData: null, // not stored in Supabase — available on Drive
    driveFileId: (row.drive_file_id as string | null) ?? null,
    driveUrl: (row.drive_url as string | null) ?? null,
    flowName: (row.flow_name as string | null) ?? null,
    appCategory: (row.app_category as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    rawResponse: (row.raw_response as Record<string, unknown>) ?? {},
    cachedAt: row.cached_at as string,
    lastSeenAt: row.last_seen_at as string,
    queries,
    tags,
  }
}

async function loadRelations(id: string): Promise<{ queries: string[]; tags: string[] }> {
  const db = getClient()
  const [qRes, tRes] = await Promise.all([
    db.from('screen_queries').select('query').eq('screen_id', id).order('added_at'),
    db.from('screen_tags').select('tag').eq('screen_id', id).order('added_at'),
  ])
  return {
    queries: (qRes.data ?? []).map((r: { query: string }) => r.query),
    tags: (tRes.data ?? []).map((r: { tag: string }) => r.tag),
  }
}

export async function upsertScreen(input: UpsertScreenInput): Promise<MobbinScreen> {
  const db = getClient()
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

  const { error } = await db.from('screens').upsert({
    id:           input.id,
    app_name:     input.appName,
    platform:     input.platform,
    image_url:    input.imageUrl,
    mobbin_url:   input.mobbinUrl,
    image_path:   imagePath,
    flow_name:    input.flowName ?? null,
    app_category: input.appCategory ?? null,
    raw_response: input.rawResponse,
    cached_at:    now,
    last_seen_at: now,
  }, { onConflict: 'id', ignoreDuplicates: false })

  if (error) throw new Error(`upsertScreen failed: ${error.message}`)

  await db.from('screen_queries').upsert(
    { screen_id: input.id, query: input.query, added_at: now },
    { onConflict: 'screen_id,query', ignoreDuplicates: true },
  )

  const { data: row } = await db.from('screens').select('*').eq('id', input.id).single()
  const { queries, tags } = await loadRelations(input.id)
  return rowToScreen(row as Record<string, unknown>, queries, tags)
}

export async function updateScreen(id: string, input: UpdateScreenInput): Promise<MobbinScreen | null> {
  const db = getClient()
  const now = new Date().toISOString()

  const { data: existing } = await db.from('screens').select('id').eq('id', id).single()
  if (!existing) return null

  const updates: Record<string, unknown> = {}
  if (input.notes !== undefined)       updates.notes = input.notes
  if (input.appCategory !== undefined) updates.app_category = input.appCategory
  if (input.flowName !== undefined)    updates.flow_name = input.flowName

  if (Object.keys(updates).length > 0) {
    const { error } = await db.from('screens').update(updates).eq('id', id)
    if (error) throw new Error(`updateScreen failed: ${error.message}`)
  }

  if (input.tags !== undefined) {
    await db.from('screen_tags').delete().eq('screen_id', id)
    if (input.tags.length > 0) {
      await db.from('screen_tags').insert(
        input.tags.map(tag => ({ screen_id: id, tag: tag.toLowerCase().trim(), added_at: now }))
      )
    }
  }

  const { data: row } = await db.from('screens').select('*').eq('id', id).single()
  const { queries, tags } = await loadRelations(id)
  return rowToScreen(row as Record<string, unknown>, queries, tags)
}

export async function addTags(id: string, tags: string[]): Promise<MobbinScreen | null> {
  const db = getClient()
  const now = new Date().toISOString()
  const { data: existing } = await db.from('screens').select('id').eq('id', id).single()
  if (!existing) return null

  await db.from('screen_tags').upsert(
    tags.map(tag => ({ screen_id: id, tag: tag.toLowerCase().trim(), added_at: now })),
    { onConflict: 'screen_id,tag', ignoreDuplicates: true },
  )

  const { data: row } = await db.from('screens').select('*').eq('id', id).single()
  const { queries, tags: allTags } = await loadRelations(id)
  return rowToScreen(row as Record<string, unknown>, queries, allTags)
}

export async function getScreen(id: string): Promise<MobbinScreen | null> {
  const db = getClient()
  const { data: row } = await db.from('screens').select('*').eq('id', id).single()
  if (!row) return null
  const { queries, tags } = await loadRelations(id)
  return rowToScreen(row as Record<string, unknown>, queries, tags)
}

export async function searchScreens(opts: SearchOptions = {}): Promise<MobbinScreen[]> {
  const db = getClient()
  let q = db.from('screens').select('*')

  if (opts.platform) q = q.eq('platform', opts.platform)
  if (opts.appName)  q = q.ilike('app_name', `%${opts.appName}%`)

  if (opts.query) {
    q = q.textSearch('search_vector', opts.query, { type: 'websearch', config: 'english' })
  } else {
    q = q.order('last_seen_at', { ascending: false })
  }

  q = q.range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50) - 1)

  const { data: rows, error } = await q
  if (error) throw new Error(`searchScreens failed: ${error.message}`)

  let results = rows as Record<string, unknown>[]

  if (opts.tags && opts.tags.length > 0) {
    const tagSet = opts.tags.map(t => t.toLowerCase().trim())
    const filtered: Record<string, unknown>[] = []
    for (const row of results) {
      const { data: rowTags } = await db.from('screen_tags').select('tag').eq('screen_id', row.id as string)
      const tagList = (rowTags ?? []).map((r: { tag: string }) => r.tag)
      if (tagSet.every(t => tagList.includes(t))) filtered.push(row)
    }
    results = filtered
  }

  return Promise.all(results.map(async row => {
    const { queries, tags } = await loadRelations(row.id as string)
    return rowToScreen(row, queries, tags)
  }))
}

export async function searchByQuery(query: string, platform?: Platform): Promise<MobbinScreen[]> {
  const db = getClient()
  let q = db.from('screen_queries').select('screen_id').eq('query', query)
  if (platform) {
    const { data: ids } = await q
    const screenIds = (ids ?? []).map((r: { screen_id: string }) => r.screen_id)
    if (screenIds.length === 0) return []
    const { data: rows } = await db.from('screens').select('*')
      .in('id', screenIds).eq('platform', platform)
    return Promise.all((rows ?? []).map(async (row: Record<string, unknown>) => {
      const { queries, tags } = await loadRelations(row.id as string)
      return rowToScreen(row, queries, tags)
    }))
  }
  const { data: ids } = await q
  const screenIds = (ids ?? []).map((r: { screen_id: string }) => r.screen_id)
  if (screenIds.length === 0) return []
  const { data: rows } = await db.from('screens').select('*').in('id', screenIds)
  return Promise.all((rows ?? []).map(async (row: Record<string, unknown>) => {
    const { queries, tags } = await loadRelations(row.id as string)
    return rowToScreen(row, queries, tags)
  }))
}

export async function listAllTags(): Promise<Array<{ tag: string; count: number }>> {
  const db = getClient()
  const { data } = await db.from('screen_tags').select('tag')
  const counts: Record<string, number> = {}
  for (const r of (data ?? []) as { tag: string }[]) {
    counts[r.tag] = (counts[r.tag] ?? 0) + 1
  }
  return Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
}

export async function listAllApps(platform?: Platform): Promise<Array<{ appName: string; count: number }>> {
  const db = getClient()
  let q = db.from('screens').select('app_name')
  if (platform) q = q.eq('platform', platform)
  const { data } = await q
  const counts: Record<string, number> = {}
  for (const r of (data ?? []) as { app_name: string }[]) {
    counts[r.app_name] = (counts[r.app_name] ?? 0) + 1
  }
  return Object.entries(counts)
    .map(([appName, count]) => ({ appName, count }))
    .sort((a, b) => b.count - a.count)
}

export async function logSearch(entry: Omit<SearchLogEntry, 'id'>): Promise<void> {
  const db = getClient()
  await db.from('search_log').insert({
    query:        entry.query,
    platform:     entry.platform,
    mode:         entry.mode,
    limit_count:  entry.limit,
    result_count: entry.resultCount,
    hit_count:    entry.hitCount,
    searched_at:  entry.searchedAt,
  })
}

export async function getStats(): Promise<{
  totalScreens: number
  totalTags: number
  totalQueries: number
  platforms: Record<string, number>
  topApps: Array<{ appName: string; count: number }>
  topTags: Array<{ tag: string; count: number }>
  recentSearches: number
}> {
  const db = getClient()
  const { data, error } = await db.rpc('get_stats')
  if (error) throw new Error(`getStats failed: ${error.message}`)
  return data as ReturnType<typeof getStats> extends Promise<infer T> ? T : never
}

export async function updateDriveInfo(id: string, driveFileId: string, driveUrl: string): Promise<void> {
  const db = getClient()
  await db.from('screens').update({ drive_file_id: driveFileId, drive_url: driveUrl }).eq('id', id)
}

export async function getScreensMissingDrive(): Promise<Array<{ id: string; appName: string; imageUrl: string }>> {
  const db = getClient()
  const { data } = await db.from('screens').select('id, app_name, image_url')
    .is('drive_file_id', null).order('app_name')
  return (data ?? []).map((r: { id: string; app_name: string; image_url: string }) => ({
    id: r.id,
    appName: r.app_name,
    imageUrl: r.image_url,
  }))
}

export async function deleteScreen(id: string): Promise<boolean> {
  const db = getClient()
  const { data: row } = await db.from('screens').select('image_path').eq('id', id).single()
  if (!row) return false
  if ((row as { image_path: string | null }).image_path) {
    const fullPath = path.join(__dirname, '..', (row as { image_path: string }).image_path)
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath)
  }
  await db.from('screens').delete().eq('id', id)
  return true
}
