/** Built-ins retain their upload/encryption formats and credential owners (Drive auth is P6). */
import { registerBackupDestination, readBackupDestinationBody } from "./registry"
import { uploadSnapshotToWebDav } from "./webdav"
import {
  getBackupDestinationsSettings,
  getGithubBackupToken,
  loadGoogleDriveTokens,
  resolveGithubBackupConfig,
  resolveGoogleDriveBackupConfig,
} from "./config"
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
      if (!resolveGoogleDriveBackupConfig(settings.googleDrive))
        return { state: "needs-setup", reasonKey: "googledrive" }
      return (await loadGoogleDriveTokens())?.refreshToken
        ? { state: "ready" }
        : { state: "needs-auth", reasonKey: "googledrive" }
    },
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

for (const [id, label] of [
  ["webdav", "WebDAV"],
  ["github", "GitHub"],
  ["googledrive", "Google Drive"],
] as const)
  registerBackupDestination(descriptor(id, label))
