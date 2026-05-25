import 'dotenv/config'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set in .env')
}

let _client: SupabaseClient | null = null

export function getClient(): SupabaseClient {
  if (_client) return _client
  _client = createClient(SUPABASE_URL!, SUPABASE_KEY!)
  return _client
}
