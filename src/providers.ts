// Remote media providers (cloud storage). Capability registry shared with the
// frontend via GET /api/providers.
//
// Google Drive is fully integrated: folder browsing (listFolderMedia), thumbnail
// proxy (proxyThumbnail) and inline streaming (proxyMedia) — see google-drive.ts.
//
// Dropbox and OneDrive currently work via direct/shared links on the client
// (no server round-trip). To enable full API integration ("browse") in a future
// iteration:
//   1. Add a secret for the provider (e.g. DROPBOX_ACCESS_TOKEN / a Microsoft
//      Graph app-only credential) to the worker bindings.
//   2. Implement listing/thumbnail/stream functions for it (a sibling of
//      google-drive.ts) and wire provider-specific routes in index.ts.
//   3. Flip `browse` to true (gated on the secret being present) below.
// The frontend reads this endpoint and automatically turns on the folder browser
// for any provider that reports `browse: true`.

export interface ProviderEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON?: string
  // Future: DROPBOX_ACCESS_TOKEN, ONEDRIVE_CLIENT_ID, etc.
}

export interface ProviderCapability {
  id: string
  label: string
  /** Folder browsing via the backend API is available. */
  browse: boolean
  /** The provider's credentials/secret are configured on this worker. */
  configured: boolean
  /** Inline byte streaming through the worker is available. */
  stream: boolean
}

export function getProviderCapabilities(env: ProviderEnv): ProviderCapability[] {
  const driveConfigured = !!env.GOOGLE_SERVICE_ACCOUNT_JSON
  return [
    { id: 'google_drive', label: 'Google Drive', browse: driveConfigured, configured: driveConfigured, stream: true },
    { id: 'dropbox',      label: 'Dropbox',      browse: false,           configured: false,           stream: false },
    { id: 'onedrive',     label: 'OneDrive',     browse: false,           configured: false,           stream: false },
  ]
}
