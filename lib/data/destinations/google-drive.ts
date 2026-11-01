/**
 * Google Drive backup destination — uploads encrypted snapshots into a folder
 * under My Drive with the `drive.file` scope (spec 2026-08-16, D).
 *
 * Layout inside the folder (mirrors the WebDAV/GitHub destinations):
 *   cognia-backup-<iso>.enc.cbk — immutable timestamped history
 *   latest.enc.cbk              — overwritten each run (O(1) restore pointer)
 *
 * Retention prunes timestamped copies down to `retainCount`. Every request
 * goes through the host-neutral HTTP helper; the access token comes from
 * the bound Google Host connection. Rust owns refresh.
 */

import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import { getSettings } from "@/lib/db/settings"
import { loggers } from "@cognia/logging"
import {
  getBackupDestinationsSettings,
  resolveGoogleDriveBackupConfig,
  updateBackupDestinationsSettings,
  type ResolvedGoogleDriveBackupConfig,
} from "./config"
import { getGoogleDriveCredentialLease } from "./google-oauth"
import {
  ConnectionRevisionChanged,
  ConnectionUnavailableError,
} from "@/lib/plugin/auth/connection-manager"
import type { BackupDestinationSnapshot } from "@cognia/plugin-contract/types/plugin/plugin-backup-destinations"
import { backupHttpRequest, parseJsonBody, type BackupHttpFn } from "./http"
import { webdavSnapshotName, type SnapshotMeta } from "./webdav"

const log = loggers.export
const DRIVE_API = "https://www.googleapis.com/drive/v3"
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3"
const FOLDER_MIME = "application/vnd.google-apps.folder"
const FILE_MIME = "application/octet-stream"
const LATEST_POINTER = "latest.enc.cbk"
const SNAPSHOT_RE = /^cognia-backup-.*\.enc\.cbk$/
const DEFAULT_RETAIN = 5
const MULTIPART_BOUNDARY = "cognia_backup_boundary_7f3a"

export type GoogleDriveUploadResult =
  | { ok: true; remotePath: string; fileId: string }
  | { ok: false; error: string; code?: "not-configured" | "not-connected" | "http" }

export interface GoogleDriveDestinationDeps {
  credentialContext?: PersonalCredentialContext
  now?: () => number
  assertActive?: () => void
  http?: BackupHttpFn
  config?: ResolvedGoogleDriveBackupConfig
}

interface DriveFile {
  id: string
  name: string
  createdTime?: string
  size?: string
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

async function resolveRetainCount(): Promise<number> {
  try {
    const settings = await getSettings()
    const n = settings.backupAutoSchedule?.retainCount
    return typeof n === "number" && n > 0 ? n : DEFAULT_RETAIN
  } catch {
    return DEFAULT_RETAIN
  }
}

async function listFiles(
  http: BackupHttpFn,
  token: string,
  query: string,
  extra: Record<string, string> = {}
): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: query,
    fields: "nextPageToken,files(id,name,createdTime,size)",
    spaces: "drive",
    pageSize: "1000",
    ...extra,
  })
  const files: DriveFile[] = []
  for (;;) {
    const response = await http({
      url: `${DRIVE_API}/files?${params.toString()}`,
      method: "GET",
      headers: authHeaders(token),
    })
    if (response.status !== 200) {
      const parsed = parseJsonBody<{ error?: { message?: string } }>(response.body)
      throw new Error(parsed?.error?.message ?? `Google Drive returned HTTP ${response.status}`)
    }
    const parsed = parseJsonBody<{ files?: DriveFile[]; nextPageToken?: string }>(response.body)
    if (Array.isArray(parsed?.files)) files.push(...parsed.files)
    if (!parsed?.nextPageToken) return files
    params.set("pageToken", parsed.nextPageToken)
  }
}

/** Find (or create) the backup folder; returns its id and persists it. */
export async function ensureGoogleDriveFolder(
  config: ResolvedGoogleDriveBackupConfig,
  token: string,
  http: BackupHttpFn = backupHttpRequest,
  assertActive: () => void = () => undefined
): Promise<string> {
  if (config.folderId) {
    // Verify the remembered id still exists (a user may have trashed it).
    const check = await http({
      url: `${DRIVE_API}/files/${encodeURIComponent(config.folderId)}?fields=id,trashed`,
      method: "GET",
      headers: authHeaders(token),
    })
    const parsed = parseJsonBody<{ id?: string; trashed?: boolean }>(check.body)
    if (check.status === 200 && parsed?.id && !parsed.trashed) return config.folderId
  }
  const existing = await listFiles(
    http,
    token,
    `name = '${escapeQuery(config.folderName)}' and mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`
  )
  let folderId = existing[0]?.id
  if (!folderId) {
    const response = await http({
      url: `${DRIVE_API}/files?fields=id`,
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: config.folderName, mimeType: FOLDER_MIME }),
    })
    const parsed = parseJsonBody<{ id?: string; error?: { message?: string } }>(response.body)
    if (response.status !== 200 || !parsed?.id) {
      throw new Error(
        parsed?.error?.message ?? `Could not create the Drive folder (HTTP ${response.status})`
      )
    }
    folderId = parsed.id
  }
  const resolved = folderId
  await updateBackupDestinationsSettings(
    (current) => ({
      ...current,
      googleDrive: current.googleDrive
        ? { ...current.googleDrive, folderId: resolved }
        : current.googleDrive,
    }),
    assertActive
  ).catch(() => undefined)
  assertActive()
  return resolved
}

function multipartBody(metadata: Record<string, unknown>, content: string): string {
  return [
    `--${MULTIPART_BOUNDARY}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${MULTIPART_BOUNDARY}`,
    `Content-Type: ${FILE_MIME}`,
    "",
    content,
    `--${MULTIPART_BOUNDARY}--`,
    "",
  ].join("\r\n")
}

async function createFile(
  http: BackupHttpFn,
  token: string,
  folderId: string,
  name: string,
  content: string
): Promise<string> {
  const response = await http({
    url: `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`,
    method: "POST",
    headers: {
      ...authHeaders(token),
      "Content-Type": `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
    },
    body: multipartBody({ name, parents: [folderId], mimeType: FILE_MIME }, content),
  })
  const parsed = parseJsonBody<{ id?: string; error?: { message?: string } }>(response.body)
  if (response.status !== 200 || !parsed?.id) {
    throw new Error(
      parsed?.error?.message ?? `Google Drive upload failed (HTTP ${response.status})`
    )
  }
  return parsed.id
}

async function updateFileContent(
  http: BackupHttpFn,
  token: string,
  fileId: string,
  content: string
): Promise<void> {
  const response = await http({
    url: `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id`,
    method: "PATCH",
    headers: { ...authHeaders(token), "Content-Type": FILE_MIME },
    body: content,
  })
  if (response.status !== 200) {
    const parsed = parseJsonBody<{ error?: { message?: string } }>(response.body)
    throw new Error(
      parsed?.error?.message ?? `Google Drive update failed (HTTP ${response.status})`
    )
  }
}

async function pruneSnapshots(http: BackupHttpFn, token: string, folderId: string): Promise<void> {
  const retain = await resolveRetainCount()
  try {
    const files = await listFiles(
      http,
      token,
      `'${escapeQuery(folderId)}' in parents and trashed = false and name contains 'cognia-backup-'`,
      { orderBy: "name desc" }
    )
    const snapshots = files
      .filter((f) => f.name !== LATEST_POINTER && SNAPSHOT_RE.test(f.name))
      .sort((a, b) => (a.name < b.name ? 1 : -1))
    for (const stale of snapshots.slice(retain)) {
      try {
        await http({
          url: `${DRIVE_API}/files/${encodeURIComponent(stale.id)}`,
          method: "DELETE",
          headers: authHeaders(token),
        })
      } catch (error) {
        rethrowConnectionError(error)
        // Best-effort; a failed prune doesn't fail the upload.
      }
    }
  } catch (error) {
    rethrowConnectionError(error)
    // Listing failed — non-fatal, the snapshot is already uploaded.
  }
}

/** Upload one encrypted envelope: timestamped snapshot + latest pointer + prune. */
export async function uploadSnapshotToGoogleDrive(
  envelopeJson: string,
  meta: SnapshotMeta,
  deps: GoogleDriveDestinationDeps = {}
): Promise<GoogleDriveUploadResult> {
  const assertActive = deps.assertActive ?? (() => undefined)
  assertActive()
  const settings = await getBackupDestinationsSettings()
  const config = deps.config ?? resolveGoogleDriveBackupConfig(settings.googleDrive)
  if (!config)
    return { ok: false, code: "not-configured", error: "Google Drive backup is not configured." }
  let context: Awaited<ReturnType<typeof driveContext>>
  try {
    context = await driveContext(deps)
  } catch (error) {
    if (error instanceof ConnectionRevisionChanged) throw error
    return {
      ok: false,
      code: "not-connected",
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const { http, token, assertCurrent } = context

  try {
    const folderId = await ensureGoogleDriveFolder(config, token, http, assertActive)
    const snapshotName = webdavSnapshotName(meta.exportedAt)
    const fileId = await createFile(http, token, folderId, snapshotName, envelopeJson)

    const latest = await listFiles(
      http,
      token,
      `'${escapeQuery(folderId)}' in parents and name = '${LATEST_POINTER}' and trashed = false`
    )
    if (latest[0]) await updateFileContent(http, token, latest[0].id, envelopeJson)
    else await createFile(http, token, folderId, LATEST_POINTER, envelopeJson)

    await pruneSnapshots(http, token, folderId)
    await assertCurrent()
    const stamp = new Date(deps.now?.() ?? Date.now()).toISOString()
    await updateBackupDestinationsSettings(
      (current) => ({
        ...current,
        googleDrive: current.googleDrive
          ? { ...current.googleDrive, lastSyncAt: stamp }
          : current.googleDrive,
      }),
      assertActive
    ).catch(() => undefined)
    assertActive()
    await assertCurrent()
    return { ok: true, fileId, remotePath: `${config.folderName}/${snapshotName}` }
  } catch (err) {
    assertActive()
    rethrowConnectionError(err)
    const error = err instanceof Error ? err.message : String(err)
    log.error("google_drive_upload_failed", undefined, { error })
    return { ok: false, code: "http", error }
  }
}

function rethrowConnectionError(error: unknown): void {
  if (error instanceof ConnectionRevisionChanged || error instanceof ConnectionUnavailableError)
    throw error
}

/** Every request, including retention/list/download, carries the same connection revision. */
async function driveContext(deps: GoogleDriveDestinationDeps) {
  const lease = await getGoogleDriveCredentialLease(deps.credentialContext)
  const http: BackupHttpFn = async (request) => {
    deps.assertActive?.()
    await lease.assertCurrent()
    try {
      return await (deps.http ?? backupHttpRequest)(request)
    } finally {
      deps.assertActive?.()
      await lease.assertCurrent()
    }
  }
  return { http, token: lease.accessToken, assertCurrent: lease.assertCurrent }
}

async function readFolder(
  config: ResolvedGoogleDriveBackupConfig,
  http: BackupHttpFn,
  token: string
) {
  if (config.folderId) return config.folderId
  return (
    await listFiles(
      http,
      token,
      `name = '${escapeQuery(config.folderName)}' and mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`
    )
  )[0]?.id
}

export async function listGoogleDriveSnapshots(
  deps: GoogleDriveDestinationDeps = {}
): Promise<BackupDestinationSnapshot[]> {
  const cfg =
    deps.config ??
    resolveGoogleDriveBackupConfig((await getBackupDestinationsSettings()).googleDrive, {
      requireEnabled: false,
    })
  if (!cfg) throw new ConnectionUnavailableError("backup-not-configured")
  const { http, token, assertCurrent } = await driveContext(deps)
  const folder = await readFolder(cfg, http, token)
  if (!folder) return []
  const files = await listFiles(
    http,
    token,
    `'${escapeQuery(folder)}' in parents and trashed = false and name contains 'cognia-backup-'`,
    { orderBy: "name desc" }
  )
  await assertCurrent()
  return files
    .filter((file) => SNAPSHOT_RE.test(file.name))
    .map((file) => ({
      remoteId: file.id,
      label: file.name,
      createdAt: file.createdTime,
      ...(file.size !== undefined ? { bytes: Number(file.size) } : {}),
    }))
}

export async function downloadGoogleDriveSnapshot(
  remoteId: string,
  deps: GoogleDriveDestinationDeps = {}
): Promise<Uint8Array> {
  const cfg =
    deps.config ??
    resolveGoogleDriveBackupConfig((await getBackupDestinationsSettings()).googleDrive, {
      requireEnabled: false,
    })
  if (!cfg) throw new ConnectionUnavailableError("backup-not-configured")
  const { http, token, assertCurrent } = await driveContext(deps)
  const folder = await readFolder(cfg, http, token)
  const metadata = await http({
    url: `${DRIVE_API}/files/${encodeURIComponent(remoteId)}?fields=name,parents,trashed`,
    method: "GET",
    headers: authHeaders(token),
  })
  const file = parseJsonBody<{ name?: string; parents?: string[]; trashed?: boolean }>(
    metadata.body
  )
  if (
    !folder ||
    metadata.status !== 200 ||
    file?.trashed ||
    !file?.parents?.includes(folder) ||
    !file.name ||
    !(SNAPSHOT_RE.test(file.name) || file.name === LATEST_POINTER)
  )
    throw new Error("Google Drive backup snapshot is unavailable")
  const response = await http({
    url: `${DRIVE_API}/files/${encodeURIComponent(remoteId)}?alt=media`,
    method: "GET",
    headers: authHeaders(token),
  })
  if (response.status !== 200) throw new Error(`Google Drive returned HTTP ${response.status}`)
  await assertCurrent()
  return new TextEncoder().encode(response.body)
}
