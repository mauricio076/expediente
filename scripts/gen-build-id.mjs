// Genera src/build-info.ts con un identificador de versión en cada build.
// Lo ejecuta wrangler como [build].command ANTES de empaquetar, así que corre
// también en el deploy automático de Cloudflare (Workers Builds) al mergear a main.
//
// El id es "<sha-corto>-<YYYYMMDD-HHMM UTC>": el SHA identifica la versión y el
// timestamp distingue redeploys del mismo commit. Permite validar qué build está
// servido (footer de la app y endpoint GET /version).
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

function shortSha() {
  // Variables que exponen los entornos de CI (Cloudflare Workers Builds, Pages, GitHub).
  const env = process.env.WORKERS_CI_COMMIT_SHA
    || process.env.CF_PAGES_COMMIT_SHA
    || process.env.GITHUB_SHA
    || ''
  if (env) return env.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'dev'
  } catch {
    return 'dev'
  }
}

const sha = shortSha()
const d = new Date()
const p = n => String(n).padStart(2, '0')
const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
const id = `${sha}-${stamp}`

writeFileSync(
  'src/build-info.ts',
  '// AUTO-GENERADO en cada build por scripts/gen-build-id.mjs — no editar a mano.\n' +
  `export const BUILD_ID = ${JSON.stringify(id)}\n`
)

console.log('[gen-build-id] BUILD_ID =', id)
