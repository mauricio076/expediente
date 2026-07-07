// OneDrive personal API via Microsoft Graph (OAuth2 authorization code + refresh token)
// Uses the /consumers/ authority: this integration targets personal Microsoft
// accounts only (OneDrive personal, not SharePoint/organizational OneDrive).

const ONEDRIVE_ID_RE = /^[a-zA-Z0-9_!.\-]+$/

function validateItemId(itemId: string): void {
  if (itemId !== 'root' && !ONEDRIVE_ID_RE.test(itemId)) throw new Error('Invalid itemId')
}

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const GRAPH = 'https://graph.microsoft.com/v1.0'
const SCOPE = 'offline_access Files.Read'

export interface OneDriveTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number // segundos
}

export function getOneDriveAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = [
    `client_id=${encodeURIComponent(clientId)}`,
    `response_type=${encodeURIComponent('code')}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    `response_mode=${encodeURIComponent('query')}`,
    `scope=${encodeURIComponent(SCOPE)}`,
    `state=${encodeURIComponent(state)}`,
  ].join('&')
  return `${AUTHORITY}/authorize?${params}`
}

interface GraphTokenResponse {
  token_type: string
  scope: string
  expires_in: number
  access_token: string
  refresh_token: string
}

export async function exchangeOneDriveCode(
  code: string, clientId: string, clientSecret: string, redirectUri: string
): Promise<OneDriveTokens> {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      scope: SCOPE,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      client_secret: clientSecret,
    }),
  })
  if (!res.ok) throw new Error(await res.text())

  const data = await res.json() as GraphTokenResponse
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  }
}

export async function refreshOneDriveToken(
  refreshToken: string, clientId: string, clientSecret: string
): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      scope: SCOPE,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      client_secret: clientSecret,
    }),
  })
  if (!res.ok) throw new Error(await res.text())

  const data = await res.json() as Partial<GraphTokenResponse>
  const result: { accessToken: string; expiresIn: number; refreshToken?: string } = {
    accessToken: data.access_token as string,
    expiresIn: data.expires_in as number,
  }
  if (data.refresh_token) result.refreshToken = data.refresh_token
  return result
}

export interface OneDriveEntry {
  id: string
  name: string
  isFolder: boolean
  mimeType: string
}

interface GraphDriveItem {
  id: string
  name: string
  size?: number
  folder?: { childCount: number }
  file?: { mimeType: string }
}

interface GraphChildrenResponse {
  value: GraphDriveItem[]
  '@odata.nextLink'?: string
}

export async function listOneDriveFolder(itemId: string, accessToken: string): Promise<OneDriveEntry[]> {
  validateItemId(itemId)

  const startUrl = itemId === 'root'
    ? `${GRAPH}/me/drive/root/children`
    : `${GRAPH}/me/drive/items/${itemId}/children`

  const allItems: GraphDriveItem[] = []
  let nextUrl: string | undefined = startUrl

  do {
    const res: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`Graph API ${res.status}: ${await res.text()}`)

    const data = await res.json() as GraphChildrenResponse
    allItems.push(...(data.value || []))
    nextUrl = data['@odata.nextLink']
  } while (nextUrl)

  const entries: OneDriveEntry[] = []
  for (const item of allItems) {
    if (item.folder) {
      entries.push({ id: item.id, name: item.name, isFolder: true, mimeType: '' })
    } else if (item.file && /^(image|video)\//i.test(item.file.mimeType)) {
      entries.push({ id: item.id, name: item.name, isFolder: false, mimeType: item.file.mimeType })
    }
  }

  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return entries
}

export async function getOneDriveThumbnail(itemId: string, accessToken: string): Promise<Response> {
  validateItemId(itemId)

  const res = await fetch(`${GRAPH}/me/drive/items/${itemId}/thumbnails/0/medium/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return new Response('Thumbnail no disponible', { status: 404 })

  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=1800',
    },
  })
}

export async function streamOneDriveFile(itemId: string, accessToken: string, range?: string | null): Promise<Response> {
  validateItemId(itemId)

  const res = await fetch(`${GRAPH}/me/drive/items/${itemId}?select=@microsoft.graph.downloadUrl`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return new Response('Media fetch failed', { status: 404 })

  const meta = await res.json() as { '@microsoft.graph.downloadUrl': string }
  const downloadUrl = meta['@microsoft.graph.downloadUrl']

  const headers: Record<string, string> = {}
  if (range) headers['Range'] = range

  const res2 = await fetch(downloadUrl, { headers })
  if (!res2.ok && res2.status !== 206) {
    return new Response('Media fetch failed', { status: res2.status === 404 ? 404 : 502 })
  }

  const out = new Headers()
  for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
    const v = res2.headers.get(h)
    if (v) out.set(h, v)
  }
  if (!out.has('Accept-Ranges')) out.set('Accept-Ranges', 'bytes')
  out.set('Cache-Control', 'private, max-age=3600')

  return new Response(res2.body, { status: res2.status, headers: out })
}
