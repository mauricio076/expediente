// Dropbox API via OAuth2 with refresh token (no service account available for Dropbox)

const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
const LIST_FOLDER_URL = 'https://api.dropboxapi.com/2/files/list_folder'
const LIST_FOLDER_CONTINUE_URL = 'https://api.dropboxapi.com/2/files/list_folder/continue'
const THUMBNAIL_URL = 'https://content.dropboxapi.com/2/files/get_thumbnail_v2'
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download'

export interface DropboxTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number // segundos
  accountId?: string
}

export function getDropboxAuthUrl(appKey: string, redirectUri: string, state: string): string {
  const params = [
    `client_id=${encodeURIComponent(appKey)}`,
    `response_type=${encodeURIComponent('code')}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    `token_access_type=${encodeURIComponent('offline')}`,
    `state=${encodeURIComponent(state)}`,
  ].join('&')
  return `https://www.dropbox.com/oauth2/authorize?${params}`
}

export async function exchangeDropboxCode(
  code: string, appKey: string, appSecret: string, redirectUri: string
): Promise<DropboxTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: appKey,
      client_secret: appSecret,
      redirect_uri: redirectUri,
    }),
  })
  if (!res.ok) throw new Error(`Dropbox token exchange error: ${await res.text()}`)

  const data = await res.json() as {
    access_token: string
    expires_in: number
    refresh_token: string
    token_type: string
    account_id?: string
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    accountId: data.account_id,
  }
}

export async function refreshDropboxToken(
  refreshToken: string, appKey: string, appSecret: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    }),
  })
  if (!res.ok) throw new Error(`Dropbox token refresh error: ${await res.text()}`)

  const data = await res.json() as {
    access_token: string
    expires_in: number
    token_type: string
  }

  return { accessToken: data.access_token, expiresIn: data.expires_in }
}

export interface DropboxEntry {
  id: string        // usa path_lower como id (Dropbox no da un fileId simple para esto)
  name: string
  isFolder: boolean
  mimeType: string   // inferido de la extensión para archivos; '' para carpetas
  path: string       // path_display (o path_lower si no viene), para volver a pedirlo
}

const MEDIA_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
}

function mimeTypeForName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return ''
  const ext = name.slice(dot).toLowerCase()
  return MEDIA_MIME_BY_EXT[ext] || ''
}

interface DropboxRawEntry {
  '.tag': 'folder' | 'file' | string
  name: string
  path_lower?: string
  path_display?: string
  id: string
}

interface ListFolderResponse {
  entries: DropboxRawEntry[]
  cursor: string
  has_more: boolean
}

export async function listDropboxFolder(path: string, accessToken: string): Promise<DropboxEntry[]> {
  const allEntries: DropboxEntry[] = []
  let cursor: string | undefined
  let hasMore = true
  let firstRequest = true

  do {
    const url = firstRequest ? LIST_FOLDER_URL : LIST_FOLDER_CONTINUE_URL
    const body = firstRequest
      ? JSON.stringify({ path, recursive: false })
      : JSON.stringify({ cursor })

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    })
    if (!res.ok) throw new Error(`Dropbox list_folder error ${res.status}: ${await res.text()}`)

    const data = await res.json() as ListFolderResponse

    for (const entry of data.entries || []) {
      const entryPath = entry.path_display || entry.path_lower || ''
      const id = entry.path_lower || entryPath

      if (entry['.tag'] === 'folder') {
        allEntries.push({
          id,
          name: entry.name,
          isFolder: true,
          mimeType: '',
          path: entryPath,
        })
      } else if (entry['.tag'] === 'file') {
        const mimeType = mimeTypeForName(entry.name)
        if (!mimeType) continue
        allEntries.push({
          id,
          name: entry.name,
          isFolder: false,
          mimeType,
          path: entryPath,
        })
      }
    }

    cursor = data.cursor
    hasMore = !!data.has_more
    firstRequest = false
  } while (hasMore)

  allEntries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return allEntries
}

export async function getDropboxThumbnail(path: string, accessToken: string): Promise<Response> {
  const apiArg = JSON.stringify({
    resource: { '.tag': 'path', path },
    format: 'jpeg',
    size: 'w256h256',
    mode: 'strict',
  })

  const res = await fetch(THUMBNAIL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': apiArg,
    },
  })

  const contentType = res.headers.get('Content-Type') || ''
  if (!res.ok || !contentType.startsWith('image/')) {
    return new Response('Thumbnail no disponible', { status: 404 })
  }

  return new Response(res.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=1800',
    },
  })
}

// Streams the raw bytes of a Dropbox file (used for inline video playback).
// Forwards the Range header so the browser can seek within the video.
export async function streamDropboxFile(path: string, accessToken: string, range?: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Dropbox-API-Arg': JSON.stringify({ path }),
  }
  if (range) headers['Range'] = range

  const res = await fetch(DOWNLOAD_URL, { method: 'POST', headers })

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
