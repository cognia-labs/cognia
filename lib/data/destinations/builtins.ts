/** Built-ins retain their upload/encryption formats and credential owners. */
import {
  getBackupDestination,
  registerBackupDestination,
  readBackupDestinationBody,
} from "./registry"
import { uploadSnapshotToWebDav } from "./webdav"
import {
  getBackupDestinationsSettings,
  getGithubBackupToken,
  resolveGithubBackupConfig,
  resolveGoogleDriveBackupConfig,
} from "./config"
import { googleState } from "@/lib/docs-providers/providers/google/state"
import { resolveGoogleDriveConnection } from "./google-oauth"
import { saveSettings } from "@/lib/db/settings"
import { getDb } from "@/lib/db/schema"
import { resolveWebDavConfig } from "@/lib/webdav/config"
import type { RegisteredBackupDestination } from "./registry"

function descriptor(
  id: "webdav" | "github" | "googledrive",
  label: string
): RegisteredBackupDestination {
  return {
    id,
    label,
    intervalEnabled: (settings) =>
      id === "webdav"
        ? settings.webdavSync?.enabled === true
        : id === "github"
          ? settings.backupDestinations?.github?.enabled === true
          : settings.backupDestinations?.googleDrive?.enabled === true,
    async readiness(signal) {
      signal.throwIfAborted()
      if (id === "webdav")
        return (await resolveWebDavConfig())
          ? { state: "ready" }
          : { state: "needs-setup", reasonKey: "webdav" }
      const settings = await getBackupDestinationsSettings()
      if (id === "github") {
        const config = resolveGithubBackupConfig(settings.github)
        if (!config) return { state: "needs-setup", reasonKey: "github" }
        return (await getGithubBackupToken(config.credential))
          ? { state: "ready" }
          : { state: "needs-auth", reasonKey: "github" }
      }
      const config = resolveGoogleDriveBackupConfig(settings.googleDrive, { requireEnabled: false })
      if (!config) return { state: "needs-setup", reasonKey: "googledrive" }
      const connection = await resolveGoogleDriveConnection()
      const snapshot = await googleState({ action: "snapshot" })
      if (
        !snapshot.clients.some(
          (client) => client.clientId === config.clientId && client.hasClientSecret
        )
      )
        return { state: "needs-setup", reasonKey: "googledrive" }
      return connection ? { state: "ready" } : { state: "needs-auth", reasonKey: "googledrive" }
    },
    ...(id === "googledrive"
      ? {
          async list(signal: AbortSignal) {
            return (await import("./google-drive")).listGoogleDriveSnapshots({
              assertActive: () => signal.throwIfAborted(),
            })
          },
          async download(remoteId: string, signal: AbortSignal) {
            return (await import("./google-drive")).downloadGoogleDriveSnapshot(remoteId, {
              assertActive: () => signal.throwIfAborted(),
            })
          },
        }
      : {}),
    async upload({ body, meta }, signal, assertOwner) {
      const assertActive = () => {
        signal.throwIfAborted()
        assertOwner?.()
      }
      assertActive()
      const bytes = await readBackupDestinationBody(body, signal)
      const json = new TextDecoder().decode(bytes)
      const snapshot = {
        filename: meta.snapshotId,
        exportedAt: meta.createdAt,
        sizeBytes: meta.bytes,
      }
      const result =
        id === "webdav"
          ? await uploadSnapshotToWebDav(json, snapshot, assertActive)
          : id === "github"
            ? await (
                await import("./github")
              ).uploadSnapshotToGithub(json, snapshot, { assertActive })
            : await (
                await import("./google-drive")
              ).uploadSnapshotToGoogleDrive(json, snapshot, { assertActive })
      assertActive()
      if (!result.ok) throw new Error(result.error)
      if (id === "webdav") {
        try {
          assertActive()
          await saveSettings(
            (settings) => {
              assertActive()
              return {
                webdavSync: { ...settings.webdavSync, lastSyncAt: new Date().toISOString() },
              }
            },
            { mirrorToHost: false, scope: { db: getDb(), assertActive } }
          )
        } catch {
          assertActive()
        }
      }
      return {
        remoteId:
          "fileId" in result && typeof result.fileId === "string"
            ? result.fileId
            : result.remotePath,
        bytes: meta.bytes,
        locationLabel: result.remotePath,
      }
    },
  }
}

// A dependency reload can retain the registry. Keep its entries and active uploads.
for (const [id, label] of [
  ["webdav", "WebDAV"],
  ["github", "GitHub"],
  ["googledrive", "Google Drive"],
] as const) {
  if (!getBackupDestination(id)) registerBackupDestination(descriptor(id, label))
}
