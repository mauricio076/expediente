import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createToken, verifyToken } from './auth'
import { getAppHtml } from './templates/app'
import { getLoginHtml } from './templates/login'
import { listFolderMedia, proxyThumbnail, proxyMedia, getFileMeta } from './google-drive'
import { getProviderCapabilities } from './providers'
import { BUILD_ID } from './build-info'
import { getShareHtml, ShareMediaVM, ShareDocVM, ShareSectionVM } from './templates/share'

type Bindings = {
  DB: D1Database
  STORAGE: R2Bucket
  APP_PASSWORD: string
  JWT_SECRET: string
  APP_USERNAME: string
  GOOGLE_SERVICE_ACCOUNT_JSON: string
}

const app = new Hono<{ Bindings: Bindings }>()

// ── Helpers ────────────────────────────────────────────────────────────────

const DEV_SECRET = 'dev-secret-change-in-production'

async function checkSession(c: { req: { raw: Request }; env: Bindings }, cookieName = 'session') {
  const cookie = getCookie(c as never, cookieName)
  if (!cookie) return null
  return verifyToken(cookie, c.env.JWT_SECRET || DEV_SECRET)
}

// ── Page auth middleware (redirect to login) ───────────────────────────────

const requirePage = async (c: any, next: any) => {
  const payload = await checkSession(c)
  if (!payload) {
    deleteCookie(c, 'session', { path: '/' })
    return c.redirect('/login')
  }
  await next()
}

// ── API auth middleware (return 401) ───────────────────────────────────────

const requireAPI = async (c: any, next: any) => {
  const payload = await checkSession(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  await next()
}

// ── Auth routes ────────────────────────────────────────────────────────────

app.get('/login', async (c) => {
  const payload = await checkSession(c)
  if (payload) return c.redirect('/')
  return c.html(getLoginHtml())
})

app.post('/login', async (c) => {
  const form = await c.req.formData()
  const username = ((form.get('username') as string) || '').trim()
  const password = (form.get('password') as string) || ''

  const expectedUser = c.env.APP_USERNAME || 'admin'
  const expectedPass = c.env.APP_PASSWORD || ''

  if (!expectedPass) {
    return c.html(getLoginHtml('La contraseña no está configurada. Configura APP_PASSWORD en los secretos del worker.'))
  }
  if (username !== expectedUser || password !== expectedPass) {
    return c.html(getLoginHtml('Usuario o contraseña incorrectos.'))
  }

  const token = await createToken(
    { sub: username, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 },
    c.env.JWT_SECRET || DEV_SECRET
  )

  setCookie(c, 'session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
  })

  return c.redirect('/')
})

app.post('/logout', (c) => {
  deleteCookie(c, 'session', { path: '/' })
  return c.redirect('/login')
})

// Identificador del build servido — público, para validar despliegues (curl /version).
app.get('/version', (c) => c.json({ build: BUILD_ID }))

// ── App ────────────────────────────────────────────────────────────────────

app.get('/', requirePage, (c) => c.html(getAppHtml(BUILD_ID)))

// ── API ────────────────────────────────────────────────────────────────────

const EMPTY_CASE = {
  caseInfo: { title: 'Mi caso', folderNo: '', court: '', status: 'En proceso', opponent: '', notes: '' },
  events: [],
  documents: [],
  photos: [],
  notes: [],
  relatedCases: [],
  pendingRequests: [],
  people: [],
  upcomingDates: [],
  shares: [],
}

async function loadCase(env: Bindings) {
  const row = await env.DB
    .prepare('SELECT data FROM case_data WHERE key = ?')
    .bind('main')
    .first<{ data: string }>()
  return row ? JSON.parse(row.data) : EMPTY_CASE
}

app.get('/api/data', requireAPI, async (c) => {
  try {
    const row = await c.env.DB
      .prepare('SELECT data FROM case_data WHERE key = ?')
      .bind('main')
      .first<{ data: string }>()
    return c.json(row ? JSON.parse(row.data) : EMPTY_CASE)
  } catch (err) {
    console.error('DB read error:', err)
    return c.json({ error: 'Database error' }, 500)
  }
})

// Handles both PUT (normal) and POST (sendBeacon on page unload)
async function saveData(c: any) {
  try {
    const data = await c.req.json()
    await c.env.DB
      .prepare(
        "INSERT OR REPLACE INTO case_data (key, data, updated_at) VALUES (?, ?, datetime('now'))"
      )
      .bind('main', JSON.stringify(data))
      .run()
    return c.json({ ok: true })
  } catch (err) {
    console.error('DB write error:', err)
    return c.json({ error: 'Database error' }, 500)
  }
}

app.put('/api/data', requireAPI, saveData)
app.post('/api/data', requireAPI, saveData)

// ── Media providers (capability gate) ──────────────────────────────────────

app.get('/api/providers', requireAPI, (c) => {
  return c.json({ providers: getProviderCapabilities(c.env) })
})

// ── Enlaces compartidos (solo lectura, público con token) ───────────────────
// El titular crea shares desde la app (data.shares). Cada share expone una
// página /share/:token y proxies de archivos LIMITADOS a los items del share:
// los archivos de Drive/R2 se sirven a través del worker, sin dar acceso a la
// nube de origen. Revocar = eliminar el share; caducidad opcional (expiresAt).

const TOKEN_RE = /^[a-f0-9]{24,64}$/

async function resolveShare(env: Bindings, token: string) {
  if (!TOKEN_RE.test(token)) return null
  const data = await loadCase(env)
  const share = (data.shares || []).find((s: { token?: string }) => s.token === token)
  if (!share) return null
  const today = new Date().toISOString().slice(0, 10)
  if (share.expiresAt && share.expiresAt < today) return null
  const all = share.scope === 'all'
  const docIds = new Set<string>(all ? (data.documents || []).map((d: { id: string }) => d.id) : (share.items?.documents || []))
  const phIds  = new Set<string>(all ? (data.photos || []).map((p: { id: string }) => p.id) : (share.items?.photos || []))
  return {
    share,
    docs:   (data.documents || []).filter((d: { id: string }) => docIds.has(d.id)),
    photos: (data.photos || []).filter((p: { id: string }) => phIds.has(p.id)),
    caseData: data,
  }
}

// Normaliza enlaces compartidos de Dropbox/OneDrive a URL reproducible.
function playableUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname.includes('dropbox.com')) { u.searchParams.delete('dl'); u.searchParams.set('raw', '1'); return u.toString() }
    if (u.hostname.includes('1drv.ms') || u.hostname.includes('onedrive.live.com') || u.hostname.includes('sharepoint.com')) {
      u.searchParams.set('download', '1'); return u.toString()
    }
  } catch { /* url inválida: se devuelve tal cual */ }
  return url
}

const isVideoItem = (p: { mimeType?: string; kind?: string; url?: string }) =>
  (p.mimeType || '').toLowerCase().startsWith('video/') || p.kind === 'video'
  || /\.(mp4|webm|ogg|ogv|mov|m4v|mkv)([?#]|$)/i.test(p.url || '')

app.get('/share/:token', async (c) => {
  const token = c.req.param('token')
  const res = await resolveShare(c.env, token)
  if (!res) return c.html('<h1 style="font-family:sans-serif">Enlace no disponible</h1><p style="font-family:sans-serif">Este enlace no existe, fue revocado o expiró.</p>', 404)
  const { share, docs, photos, caseData } = res
  const base = '/share/' + token

  const media: ShareMediaVM[] = photos.map((p: { name: string; driveFileId?: string; url?: string; caption?: string; dateAdded?: string; mimeType?: string; kind?: string }) => {
    const video = isVideoItem(p)
    let src: string | null = null
    let poster: string | null = null
    if (p.driveFileId) {
      src = base + '/media/' + p.driveFileId
      if (video) poster = base + '/thumb/' + p.driveFileId
    } else if (p.url) {
      src = playableUrl(p.url)
    }
    return { name: p.name, kind: video ? 'video' : 'image', src, poster, caption: p.caption, meta: p.dateAdded }
  })

  const docsVM: ShareDocVM[] = docs.map((d: { name: string; type?: string; r2Key?: string; url?: string; size?: number; dateAdded?: string }) => {
    if (d.type === 'r2' && d.r2Key) {
      return { name: d.name, viewUrl: base + '/file/' + d.r2Key, dlUrl: base + '/file/' + d.r2Key + '?dl=1', meta: d.dateAdded }
    }
    return { name: d.name, viewUrl: d.url || null, dlUrl: null, meta: d.dateAdded }
  })

  const sections: ShareSectionVM[] = []
  if (share.scope === 'all') {
    const ci = caseData.caseInfo || {}
    sections.push({ title: 'Datos del caso', items: [{
      title: ci.title || 'Caso',
      meta: [ci.folderNo, ci.status, ci.court, ci.opponent && ('vs ' + ci.opponent)].filter(Boolean).join(' · '),
      body: ci.notes || '',
    }] })
    const evs = (caseData.events || [])
    if (evs.length) sections.push({ title: 'Timeline (' + evs.length + ')', items: evs.map((e: { title: string; date?: string; type?: string; description?: string }) => ({ title: e.title, meta: [e.date, e.type].filter(Boolean).join(' · '), body: e.description || '' })) })
    const dates = (caseData.upcomingDates || [])
    if (dates.length) sections.push({ title: 'Próximas fechas', items: dates.map((d: { title: string; date?: string; location?: string; notes?: string }) => ({ title: d.title, meta: [d.date, d.location].filter(Boolean).join(' · '), body: d.notes || '' })) })
    const notes = (caseData.notes || [])
    if (notes.length) sections.push({ title: 'Notas y testimonios', items: notes.map((n: { title: string; date?: string; author?: string; content?: string }) => ({ title: n.title, meta: [n.date, n.author].filter(Boolean).join(' · '), body: n.content || '' })) })
  }

  return c.html(getShareHtml({
    title: share.title || 'Contenido compartido',
    caseTitle: share.scope === 'all' ? undefined : ((caseData.caseInfo || {}).title || undefined),
    expiresAt: share.expiresAt || undefined,
    media, docs: docsVM, sections,
  }), 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' })
})

app.get('/share/:token/file/:key', async (c) => {
  const res = await resolveShare(c.env, c.req.param('token'))
  if (!res) return new Response('No disponible', { status: 404 })
  const key = c.req.param('key')
  const allowed = res.docs.some((d: { r2Key?: string }) => d.r2Key === key)
  if (!allowed || !c.env.STORAGE) return new Response('No disponible', { status: 404 })
  const obj = await c.env.STORAGE.get(key)
  if (!obj) return new Response('Not found', { status: 404 })
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  if (c.req.query('dl') === '1') {
    const fname = (obj.customMetadata?.originalName || key).replace(/"/g, '')
    headers.set('Content-Disposition', 'attachment; filename="' + fname + '"')
  }
  headers.set('Cache-Control', 'private, max-age=600')
  return new Response(obj.body, { headers })
})

app.get('/share/:token/media/:fileId', async (c) => {
  const res = await resolveShare(c.env, c.req.param('token'))
  if (!res || !c.env.GOOGLE_SERVICE_ACCOUNT_JSON) return new Response('No disponible', { status: 404 })
  const fileId = c.req.param('fileId')
  if (!res.photos.some((p: { driveFileId?: string }) => p.driveFileId === fileId)) return new Response('No disponible', { status: 404 })
  try {
    return await proxyMedia(fileId, c.env.GOOGLE_SERVICE_ACCOUNT_JSON, c.req.header('Range'))
  } catch (err) {
    console.error('Share media error:', err)
    return new Response('Error', { status: 500 })
  }
})

app.get('/share/:token/thumb/:fileId', async (c) => {
  const res = await resolveShare(c.env, c.req.param('token'))
  if (!res || !c.env.GOOGLE_SERVICE_ACCOUNT_JSON) return new Response('No disponible', { status: 404 })
  const fileId = c.req.param('fileId')
  if (!res.photos.some((p: { driveFileId?: string }) => p.driveFileId === fileId)) return new Response('No disponible', { status: 404 })
  try {
    return await proxyThumbnail(fileId, c.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  } catch (err) {
    console.error('Share thumb error:', err)
    return new Response('Error', { status: 500 })
  }
})

// ── Google Drive proxy ─────────────────────────────────────────────────────

app.get('/api/drive/folder/:folderId', requireAPI, async (c) => {
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return c.json({ error: 'Google Drive no configurado. Agrega el secreto GOOGLE_SERVICE_ACCOUNT_JSON.' }, 503)
  }
  try {
    const files = await listFolderMedia(c.req.param('folderId'), c.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return c.json({ files })
  } catch (err) {
    console.error('Drive folder error:', err)
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/api/drive/file/:fileId', requireAPI, async (c) => {
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return c.json({ error: 'Google Drive no configurado. Agrega el secreto GOOGLE_SERVICE_ACCOUNT_JSON.' }, 503)
  }
  try {
    const file = await getFileMeta(c.req.param('fileId'), c.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    return c.json(file)
  } catch (err) {
    console.error('Drive file error:', err)
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/api/drive/thumb/:fileId', requireAPI, async (c) => {
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return new Response('Google Drive no configurado', { status: 503 })
  }
  try {
    return proxyThumbnail(c.req.param('fileId'), c.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  } catch (err) {
    console.error('Drive thumb error:', err)
    return new Response('Error', { status: 500 })
  }
})

app.get('/api/drive/media/:fileId', requireAPI, async (c) => {
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return new Response('Google Drive no configurado', { status: 503 })
  }
  try {
    return proxyMedia(c.req.param('fileId'), c.env.GOOGLE_SERVICE_ACCOUNT_JSON, c.req.header('Range'))
  } catch (err) {
    console.error('Drive media error:', err)
    return new Response('Error', { status: 500 })
  }
})

// ── R2 storage ─────────────────────────────────────────────────────────────

app.post('/api/upload', requireAPI, async (c) => {
  if (!c.env.STORAGE) return c.json({ error: 'Storage no configurado' }, 503)
  const fd = await c.req.formData()
  const file = fd.get('file') as File | null
  if (!file || typeof file === 'string') return c.json({ error: 'No file' }, 400)
  const name = file.name || 'file'
  const dotIdx = name.lastIndexOf('.')
  const ext = dotIdx >= 0 ? name.slice(dotIdx) : ''
  const rand = Math.random().toString(36).slice(2, 8)
  const key = 'doc-' + Date.now() + '-' + rand + ext
  await c.env.STORAGE.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { originalName: name },
  })
  return c.json({ key, name, mimeType: file.type, size: file.size })
})

app.get('/api/file/:key', requireAPI, async (c) => {
  if (!c.env.STORAGE) return new Response('Storage no configurado', { status: 503 })
  const key = c.req.param('key')
  const obj = await c.env.STORAGE.get(key)
  if (!obj) return new Response('Not found', { status: 404 })
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  if (c.req.query('dl') === '1') {
    const fname = (obj.customMetadata?.originalName || key).replace(/"/g, '')
    headers.set('Content-Disposition', 'attachment; filename="' + fname + '"')
  }
  headers.set('Cache-Control', 'private, max-age=3600')
  return new Response(obj.body, { headers })
})

app.delete('/api/file/:key', requireAPI, async (c) => {
  if (!c.env.STORAGE) return c.json({ error: 'Storage no configurado' }, 503)
  await c.env.STORAGE.delete(c.req.param('key'))
  return c.json({ ok: true })
})

export default app
