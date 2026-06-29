import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createToken, verifyToken } from './auth'
import { getAppHtml } from './templates/app'
import { getLoginHtml } from './templates/login'
import { listFolderMedia, proxyThumbnail, proxyMedia, getFileMeta } from './google-drive'
import { getProviderCapabilities } from './providers'

type Bindings = {
  DB: D1Database
  STORAGE: R2Bucket
  APP_PASSWORD: string
  JWT_SECRET: string
  APP_USERNAME: string
  GOOGLE_SERVICE_ACCOUNT_JSON: string
  BUILD_ID: string
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

// ── App ────────────────────────────────────────────────────────────────────

app.get('/', requirePage, (c) => c.html(getAppHtml(c.env.BUILD_ID || 'dev')))

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
