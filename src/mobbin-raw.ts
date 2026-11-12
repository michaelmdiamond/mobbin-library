import { waitForAuthorizationCode, writePrivateJson } from "./oauth-security"
import 'dotenv/config'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { getClient } from './db'

const MCP_URL = 'https://api.mobbin.com/mcp'
const AUTH_BASE = 'https://ujasntkfphywizsdaapi.supabase.co/auth/v1'
const REGISTER_URL = `${AUTH_BASE}/oauth/clients/register`
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE}/oauth/token`
const REDIRECT_PORT = 3741
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`
const TOKEN_PATH = path.join(__dirname, '..', 'mobbin-token.json')
const CLIENT_PATH = path.join(__dirname, '..', 'mobbin-client.json')

interface OAuthClient {
  client_id: string
  client_secret?: string
}

interface TokenSet {
  access_token: string
  refresh_token?: string
  expires_at?: number
  token_type?: string
}

interface MobbinScreenRaw {
  id: string
  image_url: string
  mobbin_url: string
  app_name: string
  platform: 'ios' | 'web'
  [key: string]: unknown
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
}

function writeJson(file: string, value: unknown): void {
  try { writePrivateJson(file, value) } catch { /* read-only FS in CCR */ }
}

async function readConfig<T>(key: string): Promise<T | null> {
  const { data } = await getClient().from('config').select('value').eq('key', key).single()
  return (data?.value as T) ?? null
}

async function writeConfig(key: string, value: unknown): Promise<void> {
  await getClient().from('config').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )
}

async function registerClient(): Promise<OAuthClient> {
  const local = readJson<OAuthClient>(CLIENT_PATH)
  if (local?.client_id) return local
  const remote = await readConfig<OAuthClient>('mobbin_client')
  if (remote?.client_id) return remote

  const res = await fetch(REGISTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'mobbin-library raw importer',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid',
    }),
  })
  if (!res.ok) throw new Error(`Client registration failed: HTTP ${res.status} ${await res.text()}`)
  const client = await res.json() as OAuthClient
  writeJson(CLIENT_PATH, client)
  await writeConfig('mobbin_client', client)
  return client
}

async function login(): Promise<TokenSet> {
  const client = await registerClient()
  const verifier = base64Url(crypto.randomBytes(32))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())
  const state = base64Url(crypto.randomBytes(16))

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', client.client_id)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', MCP_URL)

  console.error(`Open this URL to authorize Mobbin:\n${url.toString()}\n`)
  const codePromise = waitForAuthorizationCode(REDIRECT_URI, state)
  const code = await codePromise

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    resource: MCP_URL,
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status} ${await res.text()}`)
  const token = await res.json() as TokenSet & { expires_in?: number }
  if (token.expires_in) token.expires_at = Date.now() + token.expires_in * 1000
  writeJson(TOKEN_PATH, token)
  return token
}

async function refreshToken(token: TokenSet): Promise<TokenSet> {
  const client = await registerClient()
  if (!token.refresh_token) return login()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: token.refresh_token,
    resource: MCP_URL,
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) return login()
  const next = await res.json() as TokenSet & { expires_in?: number }
  if (next.expires_in) next.expires_at = Date.now() + next.expires_in * 1000
  writeJson(TOKEN_PATH, next)
  await writeConfig('mobbin_token', next)
  return next
}

async function getToken(): Promise<TokenSet> {
  const local = readJson<TokenSet>(TOKEN_PATH)
  const token = local ?? await readConfig<TokenSet>('mobbin_token')
  if (!token?.access_token) return login()
  if (token.expires_at && token.expires_at < Date.now() + 60_000) return refreshToken(token)
  return token
}

async function mcpRequest<T>(token: TokenSet, method: string, params: unknown, sessionId?: string): Promise<{ result: T; sessionId?: string }> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token.access_token}`,
      ...(sessionId ? { 'MCP-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`MCP ${method} failed: HTTP ${res.status} ${text}`)
  const dataLine = text.split('\n').find(line => line.startsWith('data: '))
  const json = JSON.parse(dataLine ? dataLine.slice(6) : text) as { result: T; error?: unknown }
  if (json.error) throw new Error(`MCP ${method} returned error: ${JSON.stringify(json.error)}`)
  return { result: json.result, sessionId: res.headers.get('mcp-session-id') ?? sessionId }
}

async function search(query: string, platform: 'ios' | 'web', limit: number, mode: 'deep' | 'standard' | 'fast'): Promise<void> {
  const token = await getToken()
  const initialized = await mcpRequest<unknown>(token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mobbin-library raw importer', version: '0.1.0' },
  })
  const found = await mcpRequest<{ content?: Array<{ type: string; text?: string }>; structuredContent?: { screens?: MobbinScreenRaw[] } }>(
    token,
    'tools/call',
    { name: 'search_screens', arguments: { query, platform, limit, mode, image_format: 'jpg' } },
    initialized.sessionId,
  )
  const screens = found.result.structuredContent?.screens ?? extractScreens(found.result.content)
  const inputs = screens.map(screen => ({
    id: screen.id,
    appName: screen.app_name,
    platform: screen.platform,
    imageUrl: screen.image_url,
    mobbinUrl: screen.mobbin_url,
    query,
    rawResponse: screen,
  }))
  process.stdout.write(JSON.stringify(inputs, null, 2))
}

function extractScreens(content?: Array<{ type: string; text?: string }>): MobbinScreenRaw[] {
  if (!content) return []
  for (const item of content) {
    if (item.type !== 'text' || !item.text) continue
    let parsed: { screens?: MobbinScreenRaw[] } | MobbinScreenRaw[]
    try {
      parsed = JSON.parse(item.text) as { screens?: MobbinScreenRaw[] } | MobbinScreenRaw[]
    } catch {
      throw new Error(`Mobbin API returned: ${item.text}`)
    }
    if (Array.isArray(parsed)) return parsed
    if (parsed.screens) return parsed.screens
  }
  return []
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'login') {
    await login()
    console.error('Mobbin raw token saved.')
    return
  }
  if (command === 'search') {
    const query = args[0]
    if (!query) throw new Error('Usage: mobbin-raw search <query> [--platform ios|web] [--limit n] [--mode deep|fast]')
    const platformIdx = args.indexOf('--platform')
    const limitIdx = args.indexOf('--limit')
    const modeIdx = args.indexOf('--mode')
    const platform = (platformIdx >= 0 ? args[platformIdx + 1] : 'ios') as 'ios' | 'web'
    const limit = Number(limitIdx >= 0 ? args[limitIdx + 1] : 30)
    const mode = (modeIdx >= 0 ? args[modeIdx + 1] : 'deep') as 'deep' | 'standard' | 'fast'
    await search(query, platform, limit, mode)
    return
  }
  console.error('Usage: mobbin-raw login | mobbin-raw search <query>')
  process.exit(1)
}

main().then(() => {
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
