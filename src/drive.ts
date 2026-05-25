import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { Readable } from 'stream'
import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json')
const TOKEN_PATH = path.join(__dirname, '..', 'token.json')
const SCOPES = ['https://www.googleapis.com/auth/drive.file']
const ROOT_FOLDER_NAME = 'Mobbin Library'
const REDIRECT_PORT = 3737
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`

const folderCache = new Map<string, string>()
let rootFolderId: string | null = null

function createOAuthClient(): OAuth2Client {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'))
  const creds = raw.installed ?? raw.web
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI)
}

export async function getAuthClient(): Promise<OAuth2Client> {
  const client = createOAuthClient()
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('Not authorized. Run: npx ts-node src/cli.ts drive-auth')
  }
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
  client.setCredentials(token)
  client.on('tokens', (tokens) => {
    const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }))
  })
  return client
}

export async function authorizeInteractive(): Promise<void> {
  const client = createOAuthClient()
  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, redirect_uri: REDIRECT_URI })

  // Spin up a local server to capture the redirect code automatically
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      if (code) {
        res.end('<html><body><h2>Authorization complete. You can close this tab.</h2></body></html>')
        server.close()
        resolve(code)
      } else {
        res.end(`<html><body><h2>Error: ${error ?? 'unknown'}</h2></body></html>`)
        server.close()
        reject(new Error(`OAuth error: ${error}`))
      }
    })
    server.listen(REDIRECT_PORT, () => {
      console.log(`\nOpen this URL in your browser to authorize Drive access:\n\n${authUrl}\n`)
      // Try to open the browser automatically
      const { exec } = require('child_process')
      exec(`open "${authUrl}"`)
    })
    server.on('error', reject)
  })

  const { tokens } = await client.getToken({ code, redirect_uri: REDIRECT_URI })
  client.setCredentials(tokens)
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens))
  console.log('Authorization complete. Token saved.')
}

function fetchBuffer(url: string, redirects = 5): Promise<{ buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    if (redirects === 0) { reject(new Error('Too many redirects')); return }
    const get = url.startsWith('https') ? https.get : http.get
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location, redirects - 1).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] ?? 'image/jpeg' }))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function getOrCreateFolder(drive: ReturnType<typeof google.drive>, name: string, parentId?: string): Promise<string> {
  const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const q = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`
  const res = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 })
  if (res.data.files?.length) return res.data.files[0].id!
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) },
    fields: 'id',
  })
  return created.data.id!
}

async function getRootFolder(drive: ReturnType<typeof google.drive>): Promise<string> {
  if (!rootFolderId) rootFolderId = await getOrCreateFolder(drive, ROOT_FOLDER_NAME)
  return rootFolderId
}

async function getAppFolder(drive: ReturnType<typeof google.drive>, appName: string): Promise<string> {
  if (!folderCache.has(appName)) {
    const root = await getRootFolder(drive)
    folderCache.set(appName, await getOrCreateFolder(drive, appName, root))
  }
  return folderCache.get(appName)!
}

export interface DriveUploadResult {
  fileId: string
  webViewLink: string
}

export async function uploadScreenImage(screenId: string, appName: string, imageUrl: string): Promise<DriveUploadResult> {
  const auth = await getAuthClient()
  const drive = google.drive({ version: 'v3', auth })

  const { buffer, contentType } = await fetchBuffer(imageUrl)
  const ext = contentType.includes('webp') ? 'webp' : 'jpg'
  const folderId = await getAppFolder(drive, appName)

  const res = await drive.files.create({
    requestBody: { name: `${screenId}.${ext}`, parents: [folderId] },
    media: { mimeType: contentType, body: Readable.from(buffer) },
    fields: 'id,webViewLink',
  })

  return { fileId: res.data.id!, webViewLink: res.data.webViewLink! }
}
