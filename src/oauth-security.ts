import * as http from 'http'
import * as fs from 'fs'
import { timingSafeEqual } from 'crypto'

export function writePrivateJson(file: string, value: unknown): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600)
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(value, null, 2)) }
  finally { fs.closeSync(fd) }
}

export function waitForAuthorizationCode(redirectUri: string, state: string, onListening?: (url: string) => void, timeoutMs = 120_000): Promise<string> {
  if (!state) return Promise.reject(new Error('OAuth state is required'))
  return new Promise((resolve, reject) => {
    const expected = new URL(redirectUri)
    let timer: NodeJS.Timeout
    const finish = (error?: Error, code?: string) => {
      clearTimeout(timer); server.close(); server.closeAllConnections()
      if (error) reject(error); else resolve(code!)
    }
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      let url: URL
      try { url = new URL(req.url || '/', expected) }
      catch { res.writeHead(400); res.end('Invalid authorization callback'); return }
      const supplied = Buffer.from(url.searchParams.get('state') || '')
      const wanted = Buffer.from(state)
      if (req.method !== 'GET' || req.headers.host !== expected.host || url.pathname !== expected.pathname || supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
        res.writeHead(400); res.end('Invalid authorization callback'); return
      }
      const code = url.searchParams.get('code')
      if (!code || url.searchParams.has('error')) {
        res.writeHead(400); res.end('Authorization failed. Please retry login.');
        // Finish after the response is flushed, without reflecting provider input.
        res.once('finish', () => finish(new Error('Authorization failed'))); return
      }
      res.end('Authorization complete. You may close this tab.')
      res.once('finish', () => finish(undefined, code))
    })
    server.headersTimeout = 10_000
    server.requestTimeout = 15_000
    server.on('error', error => finish(error))
    timer = setTimeout(() => finish(new Error('Authorization timed out')), timeoutMs)
    server.listen(Number(expected.port), '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address !== 'string') expected.port = String(address.port)
      onListening?.(expected.toString())
    })
  })
}
