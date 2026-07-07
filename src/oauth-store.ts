// D1-backed storage for account-wide OAuth tokens (Dropbox, OneDrive).
// One row per provider. Access tokens are refreshed in place and persisted
// back to D1 so the connection survives across requests/deploys without
// re-authenticating. Google Drive does not use this — it authenticates via
// a service account secret (see google-drive.ts).

export interface ProviderToken {
  provider: string
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms
  accountLabel?: string
}

interface ProviderTokenRow {
  provider: string
  access_token: string
  refresh_token: string
  expires_at: number
  account_label: string | null
}

export async function getProviderToken(db: D1Database, provider: string): Promise<ProviderToken | null> {
  const row = await db
    .prepare('SELECT provider, access_token, refresh_token, expires_at, account_label FROM provider_tokens WHERE provider = ?')
    .bind(provider)
    .first<ProviderTokenRow>()
  if (!row) return null
  return {
    provider: row.provider,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    accountLabel: row.account_label || undefined,
  }
}

export async function saveProviderToken(db: D1Database, token: ProviderToken): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_tokens (provider, access_token, refresh_token, expires_at, account_label, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(provider) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         account_label = excluded.account_label,
         updated_at = datetime('now')`
    )
    .bind(token.provider, token.accessToken, token.refreshToken, token.expiresAt, token.accountLabel || null)
    .run()
}

export async function deleteProviderToken(db: D1Database, provider: string): Promise<void> {
  await db.prepare('DELETE FROM provider_tokens WHERE provider = ?').bind(provider).run()
}

export interface RefreshResult {
  accessToken: string
  expiresIn: number // seconds
  refreshToken?: string // some providers (Microsoft) rotate the refresh token
}

const EXPIRY_SAFETY_MARGIN_MS = 60_000

// Returns a valid access token for `provider`, refreshing and persisting a new
// one via `refresh` if the stored token is missing/expired. Returns null if
// the provider has never been connected (no row in D1).
export async function getValidAccessToken(
  db: D1Database,
  provider: string,
  refresh: (refreshToken: string) => Promise<RefreshResult>
): Promise<string | null> {
  const token = await getProviderToken(db, provider)
  if (!token) return null
  if (token.expiresAt > Date.now() + EXPIRY_SAFETY_MARGIN_MS) return token.accessToken

  const refreshed = await refresh(token.refreshToken)
  const updated: ProviderToken = {
    provider,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || token.refreshToken,
    expiresAt: Date.now() + refreshed.expiresIn * 1000,
    accountLabel: token.accountLabel,
  }
  await saveProviderToken(db, updated)
  return updated.accessToken
}
