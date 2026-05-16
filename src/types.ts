export type Platform = 'ios' | 'web'
export type SearchMode = 'deep' | 'fast'

export interface MobbinScreen {
  id: string
  appName: string
  platform: Platform
  imageUrl: string
  mobbinUrl: string
  imagePath: string | null      // local file path relative to project root, null if not downloaded
  imageData: Buffer | null      // raw image bytes if stored in DB
  queries: string[]             // all queries that surfaced this screen
  tags: string[]                // user-defined tags
  notes: string | null
  flowName: string | null       // Mobbin flow/category name if available
  appCategory: string | null    // e.g. "Finance", "Social", "Productivity"
  rawResponse: Record<string, unknown>  // full MCP response object for this screen
  cachedAt: string              // ISO timestamp
  lastSeenAt: string            // ISO timestamp
}

export interface SearchLogEntry {
  id: number
  query: string
  platform: Platform
  mode: SearchMode
  limit: number
  resultCount: number
  hitCount: number              // how many results came from cache
  searchedAt: string
}

export interface UpsertScreenInput {
  id: string
  appName: string
  platform: Platform
  imageUrl: string
  mobbinUrl: string
  query: string
  flowName?: string
  appCategory?: string
  rawResponse: Record<string, unknown>
  imageData?: Buffer
}

export interface UpdateScreenInput {
  tags?: string[]
  notes?: string
  appCategory?: string
  flowName?: string
}

export interface SearchOptions {
  query?: string
  platform?: Platform
  tags?: string[]
  appName?: string
  limit?: number
  offset?: number
}
