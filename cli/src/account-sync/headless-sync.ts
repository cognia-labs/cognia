/**
 * Account sync for a headless host, as the `cognia-agent account-sync`
 * commands and `cognia-agent serve` both see it (ADR-0215 phase 3a):
 *
 * - **Who:** the person the local account is bound to (`cognia-agent logto
 *   login --account <id>`, the file session in `~/.cognia/accounts/<id>/`),
 *   refreshed as needed. Only the official issuer's person counts, as in the
 *   app (`lib/account-sync/sync-session`), and only while the account's
 *   session still signs in as them.
 * - **Keys:** `~/.cognia/account-sync/`, one 0600 file per secret, shared by
 *   the commands that enroll and the brain that syncs.
 * - **Backup:** before a join changes the brain's data, an encrypted backup
 *   into the scheduled-backup folder (or `<serve home>/backups`), recorded in
 *   backup history like any other.
 *
 * Off unless `COGNIA_ACCOUNT_SYNC` (or the app's `NEXT_PUBLIC_COGNIA_ACCOUNT_SYNC`)
 * says `1`/`true`/`on`: the commands refuse and the brain gets no host.
 */

import path from "node:path"
import { randomUUID } from "node:crypto"

import { spaceIdFor } from "@cognia/sync-protocol"

import type { HeadlessAccountSyncHost } from "@/lib/account-sync/data/headless-host"
import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import type { SyncSession } from "@/lib/account-sync/sync-session"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { writeEncryptedLocalBackup, type BackupFilesystem } from "@/lib/data/backup-scheduler"
import { defaultExportFileName } from "@/lib/data/build-package"
import { appendBackupHistory } from "@/lib/db/backup-history"
import { getSettings } from "@/lib/db/settings"
import {
  isOfficialIssuer,
  officialDeployment,
  officialSyncUrl,
} from "@/lib/identity/official-deployment"
import { accountSignInDir } from "../config/local-account"
import {
  freshSessionFor,
  readBoundPerson,
  type BoundPerson,
  type FreshLogtoSessionDeps,
} from "../config/logto-session"
import { createFileKeyringStore } from "./file-keyring-store"

export type HeadlessSyncEnv = Record<string, string | undefined>

export function headlessAccountSyncEnabled(env: HeadlessSyncEnv): boolean {
  return accountSyncEnabled({
    flag: env.COGNIA_ACCOUNT_SYNC ?? env.NEXT_PUBLIC_COGNIA_ACCOUNT_SYNC,
    nodeEnv: env.NODE_ENV,
  })
}

export function accountSyncDir(cliHome: string): string {
  return path.join(cliHome, "account-sync")
}

export function headlessKeyring(cliHome: string): KeyringStore {
  return createFileKeyringStore(accountSyncDir(cliHome))
}

export interface HeadlessSessionInput {
  cliHome: string
  localAccountId: string
  env: HeadlessSyncEnv
  deps?: FreshLogtoSessionDeps
  /**
   * The person the caller acts for. The Brain pins it at start
   * (`pinBoundPerson`); a command reads the account's binding when absent.
   */
  person?: () => BoundPerson | null
}

/**
 * The account's sync session, or null when the account is not bound to an
 * official-account person or its session no longer signs in as them.
 *
 * Throws when the account's binding file cannot be read, so a command can say
 * so instead of calling the account signed out.
 */
export async function headlessSyncSession(
  input: HeadlessSessionInput
): Promise<SyncSession | null> {
  const { cliHome, localAccountId, env, deps } = input
  // The CLI always offers the official account; COGNIA_ID_* point it elsewhere (staging).
  const deployment = officialDeployment({
    issuer: env.COGNIA_ID_ISSUER,
    audience: env.COGNIA_ID_AUDIENCE,
  })
  if (!deployment) return null
  const dir = accountSignInDir(cliHome, localAccountId)
  const person = input.person ? input.person() : readBoundPerson(dir, deps?.sessionFs)
  if (!person || !isOfficialIssuer(person.issuer, deployment)) return null
  // The official issuer's subject is the person's `usr_` id; anything else is no person.
  if (!person.subject.startsWith("usr_")) return null
  if (!(await freshSessionFor(dir, person, deps))) return null
  const userId = person.subject
  return {
    localAccountId,
    issuer: deployment.issuer,
    userId,
    spaceId: await spaceIdFor(deployment.issuer, userId),
    syncUrl: officialSyncUrl(env.COGNIA_SYNC_URL ?? env.NEXT_PUBLIC_COGNIA_SYNC_URL),
    async accessToken() {
      // A sign-in as someone else since must not act on this person's space.
      return (await freshSessionFor(dir, person, deps))?.accessToken ?? null
    },
  }
}

export interface BrainBackupInput {
  filesystem: BackupFilesystem
  /** Used when no scheduled-backup folder is set. */
  fallbackDir: string
  now?: () => Date
}

/** An encrypted backup of the brain's database, recorded in backup history; throws on failure. */
export function brainBackup(input: BrainBackupInput): () => Promise<void> {
  return async () => {
    const settings = await getSettings()
    const directory = (settings.backupAutoSchedule?.dirPath || input.fallbackDir).replace(
      /[/\\]+$/,
      ""
    )
    const now = input.now?.() ?? new Date()
    const timestamp = now.toISOString().replace(/[-:.]/g, "")
    const fileName = defaultExportFileName(
      now,
      "encrypted",
      input.filesystem.installationId
    ).replace("-owner-", `-prejoin-${timestamp}-${randomUUID()}-owner-`)
    try {
      const passphrase = await getDefaultBackupPassphrase()
      if (!passphrase) throw new Error("the backup key of this host is unavailable")
      const written = await writeEncryptedLocalBackup(
        input.filesystem,
        path.join(directory, fileName),
        { includeSessions: true, includeApiKey: false },
        passphrase
      )
      await appendBackupHistory({
        completedAt: Date.now(),
        type: "auto",
        success: true,
        encryption: "auto-key",
        sizeBytes: written.sizeBytes,
        filename: fileName,
        deviceId: written.deviceId,
        deviceLabel: written.deviceLabel,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendBackupHistory({
        completedAt: Date.now(),
        type: "auto",
        success: false,
        encryption: "auto-key",
        errorMessage: message,
      }).catch(() => undefined)
      throw error
    }
  }
}

export interface BrainAccountSyncInput {
  cliHome: string
  localAccountId: string
  env: HeadlessSyncEnv
  backup: () => Promise<void>
  /** The person this Brain acts for, pinned at start. */
  person: () => BoundPerson | null
}

/** What `cognia-agent serve` hands the brain's `account-sync` runtime, or undefined when off. */
export function brainAccountSyncHost(
  input: BrainAccountSyncInput
): HeadlessAccountSyncHost | undefined {
  if (!headlessAccountSyncEnabled(input.env)) return undefined
  return {
    session: () =>
      headlessSyncSession({
        cliHome: input.cliHome,
        localAccountId: input.localAccountId,
        env: input.env,
        person: input.person,
      }),
    signInCommand: `cognia-agent logto login --account ${input.localAccountId}`,
    keyring: headlessKeyring(input.cliHome),
    backup: input.backup,
  }
}
