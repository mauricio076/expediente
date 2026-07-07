// Remote media providers (cloud storage). Capability registry shared with the
// frontend via GET /api/providers.
//
// Google Drive is fully integrated via a service account (google-drive.ts):
// folder browsing, thumbnail proxy and inline streaming, no user interaction
// needed beyond the folder link.
//
// Dropbox and OneDrive are fully integrated via per-account OAuth (dropbox.ts /
// onedrive.ts): the owner connects their account once (GET /api/<provider>/connect),
// tokens are stored in D1 (oauth-store.ts) and refreshed automatically. Until
// connected, `browse` stays false and the frontend falls back to pasting a
// shared link. `configured` means the worker has the OAuth app secrets set;
// `connected` means the owner has completed the one-time OAuth flow.

import { getProviderToken } from './oauth-store'

export interface ProviderEnv {
  DB: D1Database
  GOOGLE_SERVICE_ACCOUNT_JSON?: string
  DROPBOX_APP_KEY?: string
  DROPBOX_APP_SECRET?: string
  ONEDRIVE_CLIENT_ID?: string
  ONEDRIVE_CLIENT_SECRET?: string
}

export interface ProviderCapability {
  id: string
  label: string
  /** Folder browsing via the backend API is available right now. */
  browse: boolean
  /** The provider's OAuth app / service account secrets are configured on this worker. */
  configured: boolean
  /** An active connection exists (OAuth tokens in D1, or n/a for Google Drive). */
  connected: boolean
  /** Inline byte streaming through the worker is available. */
  stream: boolean
}

export async function getProviderCapabilities(env: ProviderEnv): Promise<ProviderCapability[]> {
  const driveConfigured = !!env.GOOGLE_SERVICE_ACCOUNT_JSON
  const dropboxConfigured = !!(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET)
  const onedriveConfigured = !!(env.ONEDRIVE_CLIENT_ID && env.ONEDRIVE_CLIENT_SECRET)

  const [dropboxToken, onedriveToken] = await Promise.all([
    dropboxConfigured ? getProviderToken(env.DB, 'dropbox') : Promise.resolve(null),
    onedriveConfigured ? getProviderToken(env.DB, 'onedrive') : Promise.resolve(null),
  ])

  return [
    { id: 'google_drive', label: 'Google Drive', browse: driveConfigured, configured: driveConfigured, connected: driveConfigured, stream: true },
    { id: 'dropbox', label: 'Dropbox', browse: !!dropboxToken, configured: dropboxConfigured, connected: !!dropboxToken, stream: true },
    { id: 'onedrive', label: 'OneDrive', browse: !!onedriveToken, configured: onedriveConfigured, connected: !!onedriveToken, stream: true },
  ]
}
