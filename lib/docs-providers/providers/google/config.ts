/**
 * Google Workspace document connection — settings + secret storage.
 *
 * AppSettings stores client preferences. Rust owns client-keyed secrets and
 * Google lineages; this module consumes metadata without reading credentials.
 */

import type { GoogleDocsProviderSettings } from "@cognia/agent-config-types"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { googleState, subscribeGoogleStateChanged } from "./state"

/**
 * Read scopes. `drive.readonly` alone cannot read a Doc's body (Drive only
 * exports it) and cannot read a multi-tab spreadsheet, so all three are
 * requested together:
 *   - `drive.readonly`        — list/search files, export a Doc to markdown
 *   - `documents.readonly`    — Docs API structured read (fallback path)
 *   - `spreadsheets.readonly` — per-worksheet values, which Drive export cannot give
 *
 * NOT obtainable through Google's device-code flow (that flow allows only
 * email/profile/openid, drive.appdata and drive.file), which is why this
 * connection uses the installed-app loopback redirect instead.
 */
export const GOOGLE_DOCS_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
] as const

export const GOOGLE_DOCS_SCOPE_STRING = GOOGLE_DOCS_SCOPES.join(" ")

export async function getGoogleDocsSettings(): Promise<GoogleDocsProviderSettings> {
  let preferences: GoogleDocsProviderSettings = {}
  try {
    preferences = (await getSettings()).docsProviders?.google ?? {}
  } catch {
    /* Read-only UI remains usable while the DB is unavailable. */
  }
  return connectionSettings(preferences)
}

async function connectionSettings(
  preferences: GoogleDocsProviderSettings
): Promise<GoogleDocsProviderSettings> {
  try {
    const { lineages } = await googleState({
      action: "snapshot",
      legacyClientId: preferences.clientId,
    })
    const connection = lineages.find(
      (lineage) =>
        lineage.status === "connected" &&
        GOOGLE_DOCS_SCOPES.every((scope) => lineage.scopes.includes(scope))
    )
    return {
      ...preferences,
      connected: Boolean(connection),
      accountEmail: connection?.email ?? undefined,
      grantedScopes: connection?.scopes.join(" "),
    }
  } catch {
    // Never trust a singleton's stale connected flag if the credential owner
    // cannot confirm it. Authoritative operations surface their actual error.
    return { clientId: preferences.clientId, connected: false }
  }
}

type GoogleSettingsListener = (settings: GoogleDocsProviderSettings) => void
const settingsListeners = new Set<GoogleSettingsListener>()
let stopStateSubscription: (() => void) | undefined
let notificationVersion = 0
function notifySettings(settings: GoogleDocsProviderSettings) {
  for (const listener of settingsListeners) {
    try {
      listener(settings)
    } catch {
      /* A listener cannot undo a committed save. */
    }
  }
}
async function reloadConnection() {
  const version = ++notificationVersion
  const settings = await getGoogleDocsSettings()
  if (version === notificationVersion) notifySettings(settings)
}

/** Observe committed connection state in the credential-owning host. */
export function subscribeGoogleDocsSettings(listener: GoogleSettingsListener): () => void {
  settingsListeners.add(listener)
  if (!stopStateSubscription)
    stopStateSubscription = subscribeGoogleStateChanged(() => {
      void reloadConnection()
    })
  return () => {
    settingsListeners.delete(listener)
    if (!settingsListeners.size) {
      stopStateSubscription?.()
      stopStateSubscription = undefined
    }
  }
}

export async function updateGoogleDocsSettings(
  patch:
    | Partial<GoogleDocsProviderSettings>
    | ((current: GoogleDocsProviderSettings) => GoogleDocsProviderSettings)
): Promise<GoogleDocsProviderSettings> {
  // Apply inside the database's existing save queue, never to a stale snapshot.
  const saved = await saveSettings((settings) => {
    const providers = settings.docsProviders ?? {}
    const current = providers.google ?? {}
    const next = typeof patch === "function" ? patch(current) : { ...current, ...patch }
    return { docsProviders: { ...providers, google: next } }
  })
  // The DB keeps preferences; host state supplies credential readiness.
  const next = await connectionSettings(saved.docsProviders?.google ?? {})
  ++notificationVersion
  notifySettings(next)
  return next
}

/** Write-only: renderer code can observe presence, never retrieve the secret. */
export async function saveGoogleClientSecret(
  secret: string,
  configuredClientId?: string
): Promise<void> {
  const clientId = (configuredClientId ?? (await getGoogleDocsSettings()).clientId)?.trim()
  if (!clientId) throw new Error("Google OAuth client id is required")
  await googleState({ action: "setClientSecret", clientId, secret })
}

export async function clearGoogleClientSecret(clientId: string): Promise<void> {
  await googleState({ action: "clearClientSecret", clientId })
}
