// Google Drive API via Service Account (RS256 JWT, Web Crypto)

interface ServiceAccount {
  client_email: string
  private_key: string
}

interface TokenCache {
  token: string
  expires: number
}

interface ThumbCache {
  url: string
  expires: number
}

let tokenCache: TokenCache | null = null
// thumbnailLinks are short-lived; cache them for 30 minutes only
const thumbUrlCache = new Map<string, ThumbCache>()

const DRIVE_ID_RE = /^[a-zA-Z0-9_-]+$/

function validateId(id: string, label: string): void {
  if (!id || !DRIVE_ID_RE.test(id)) throw new Error(`Invalid ${label}`)
}

function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function objB64url(obj: object): string {
  return toB64url(new TextEncoder().encode(JSON.stringify(obj)))
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token

  const now = Math.floor(Date.now() / 1000)
  const header  = objB64url({ alg: 'RS256', typ: 'JWT' })
  const payload = objB64url({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  })
  const toSign = `${header}.${payload}`

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0))

  const key = await crypto.subtle.importKey(
    'pkcs8', keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  )
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(toSign))
  const jwt = `${toSign}.${toB64url(new Uint8Array(sig))}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!res.ok) throw new Error(`Token error: ${await res.text()}`)

  const data = await res.json() as { access_token: string; expires_in: number }
  tokenCache = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 }
  return tokenCache.token
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  thumbnailLink?: string
  webViewLink?: string
}

export async function listFolderMedia(folderId: string, saJson: string): Promise<DriveFile[]> {
  validateId(folderId, 'folderId')
  const sa: ServiceAccount = JSON.parse(saJson)
  const token = await getAccessToken(sa)

  const allFiles: DriveFile[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({
      q:        `'${folderId}' in parents and (mimeType contains 'image/' or mimeType contains 'video/') and trashed = false`,
      fields:   'nextPageToken,files(id,name,mimeType,thumbnailLink,webViewLink)',
      pageSize: '1000',
      orderBy:  'name',
    })
    if (pageToken) params.set('pageToken', pageToken)

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`)

    const data = await res.json() as { files: DriveFile[]; nextPageToken?: string }
    const files = data.files || []

    const ttl = Date.now() + 30 * 60 * 1000 // thumbnailLinks are short-lived
    for (const f of files) {
      if (f.thumbnailLink) thumbUrlCache.set(f.id, { url: f.thumbnailLink, expires: ttl })
    }

    allFiles.push(...files)
    pageToken = data.nextPageToken
  } while (pageToken)

  return allFiles
}

export async function proxyThumbnail(fileId: string, saJson: string): Promise<Response> {
  validateId(fileId, 'fileId')

  const cached = thumbUrlCache.get(fileId)
  let thumbUrl = cached && cached.expires > Date.now() ? cached.url : undefined

  if (!thumbUrl) {
    const sa: ServiceAccount = JSON.parse(saJson)
    const token = await getAccessToken(sa)
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!res.ok) return new Response('Not found', { status: 404 })
    const meta = await res.json() as { thumbnailLink?: string }
    if (!meta.thumbnailLink) return new Response('No thumbnail available', { status: 404 })
    thumbUrl = meta.thumbnailLink
    thumbUrlCache.set(fileId, { url: thumbUrl, expires: Date.now() + 30 * 60 * 1000 })
  }

  const url = thumbUrl.replace(/=s\d+$/, '=s600')
  const imgRes = await fetch(url)
  if (!imgRes.ok) return new Response('Thumbnail fetch failed', { status: 502 })

  return new Response(imgRes.body, {
    headers: {
      'Content-Type': imgRes.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=1800',
    },
  })
}

// Streams the raw bytes of a Drive file (used for inline video playback).
// Forwards the Range header so the browser can seek within the video.
export async function proxyMedia(fileId: string, saJson: string, range?: string | null): Promise<Response> {
  validateId(fileId, 'fileId')

  const sa: ServiceAccount = JSON.parse(saJson)
  const token = await getAccessToken(sa)

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (range) headers['Range'] = range

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers }
  )
  if (!res.ok && res.status !== 206) {
    return new Response('Media fetch failed', { status: res.status === 404 ? 404 : 502 })
  }

  const out = new Headers()
  for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
    const v = res.headers.get(h)
    if (v) out.set(h, v)
  }
  if (!out.has('Accept-Ranges')) out.set('Accept-Ranges', 'bytes')
  out.set('Cache-Control', 'private, max-age=3600')

  return new Response(res.body, { status: res.status, headers: out })
}

// Metadata of a single Drive file (used to import an individual file by link).
export async function getFileMeta(fileId: string, saJson: string): Promise<DriveFile> {
  validateId(fileId, 'fileId')
  const sa: ServiceAccount = JSON.parse(saJson)
  const token = await getAccessToken(sa)

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,thumbnailLink,webViewLink`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (res.status === 404) throw new Error('Archivo no encontrado')
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`)

  const meta = await res.json() as DriveFile
  if (meta.thumbnailLink) {
    thumbUrlCache.set(meta.id, { url: meta.thumbnailLink, expires: Date.now() + 30 * 60 * 1000 })
  }
  return meta
}

export function extractFolderId(url: string): string | null {
  const m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  return m ? m[1] : null
}
