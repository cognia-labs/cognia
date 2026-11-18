/** @jest-environment node */

const writeEncryptedLocalBackup = jest.fn()
const appendBackupHistory = jest.fn(async (_row: unknown) => undefined)
const getDefaultBackupPassphrase = jest.fn(async (): Promise<string | null> => "pass")
const getSettings = jest.fn(async (): Promise<Record<string, unknown>> => ({}))

jest.mock("@/lib/data/backup-scheduler", () => ({
  writeEncryptedLocalBackup: (...args: unknown[]) => writeEncryptedLocalBackup(...args),
}))
jest.mock("@/lib/db/backup-history", () => ({
  appendBackupHistory: (row: unknown) => appendBackupHistory(row),
}))
jest.mock("@/lib/data/backup-key", () => ({
  getDefaultBackupPassphrase: () => getDefaultBackupPassphrase(),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: "headless-account-db" }) }))

import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { createNodeBackupFilesystem } from "../serve/backup-filesystem"

import { spaceIdFor } from "@cognia/sync-protocol"

import { officialDeployment } from "@/lib/identity/official-deployment"

import { accountSignInDir } from "../config/local-account"
import {
  logtoBoundPersonPath,
  logtoSessionPath,
  type BoundPerson,
  type LogtoSessionFs,
} from "../config/logto-session"
import {
  accountSyncDir,
  brainAccountSyncHost,
  brainBackup,
  headlessAccountSyncEnabled,
  headlessSyncSession,
} from "./headless-sync"

const HOME = "/home/u/.cognia"
const ISSUER = officialDeployment({})!.issuer
const DIR = accountSignInDir(HOME, "local_acct_a")

const token = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`
const personFor = (subject: string, issuer = ISSUER): BoundPerson => ({
  issuer,
  subject,
  boundAt: 1,
})

/** The account's session file and binding, in memory. */
function sessionFs(
  session: Record<string, unknown> | null,
  person: BoundPerson | string | null = session
    ? personFor(
        JSON.parse(Buffer.from(String(session.accessToken).split(".")[1]!, "base64url").toString())
          .sub,
        String(session.issuer)
      )
    : null
): LogtoSessionFs & { set: (s: unknown) => void } {
  let raw = session ? JSON.stringify(session) : null
  const binding =
    person === null ? null : typeof person === "string" ? person : JSON.stringify(person)
  return {
    read: (file) =>
      file === logtoSessionPath(DIR) ? raw : file === logtoBoundPersonPath(DIR) ? binding : null,
    write: (_file, content) => {
      raw = content
    },
    remove: () => {
      raw = null
    },
    mkdirp: () => undefined,
    listDirs: () => [],
    set: (next) => {
      raw = JSON.stringify(next)
    },
  }
}

beforeEach(() => {
  writeEncryptedLocalBackup
    .mockReset()
    .mockResolvedValue({ sizeBytes: 12, deviceId: "dev", deviceLabel: "srv" })
  appendBackupHistory.mockReset().mockResolvedValue(undefined)
  getDefaultBackupPassphrase.mockReset().mockResolvedValue("pass")
  getSettings.mockReset().mockResolvedValue({})
})

describe("headlessAccountSyncEnabled", () => {
  it("follows COGNIA_ACCOUNT_SYNC, then the app's flag, and is off by default", () => {
    expect(headlessAccountSyncEnabled({})).toBe(false)
    expect(headlessAccountSyncEnabled({ COGNIA_ACCOUNT_SYNC: "1" })).toBe(true)
    expect(headlessAccountSyncEnabled({ NEXT_PUBLIC_COGNIA_ACCOUNT_SYNC: "on" })).toBe(true)
    expect(
      headlessAccountSyncEnabled({
        COGNIA_ACCOUNT_SYNC: "off",
        NEXT_PUBLIC_COGNIA_ACCOUNT_SYNC: "1",
      })
    ).toBe(false)
  })
})

describe("headlessSyncSession", () => {
  const input = (fs: LogtoSessionFs, env: Record<string, string> = {}) => ({
    cliHome: HOME,
    localAccountId: "local_acct_a",
    env,
    deps: { sessionFs: fs, now: () => 0 },
  })

  it("is null when signed out or signed in to another issuer", async () => {
    expect(await headlessSyncSession(input(sessionFs(null)))).toBeNull()
    const foreign = sessionFs({ issuer: "https://logto.example/oidc", accessToken: token("usr_a") })
    expect(await headlessSyncSession(input(foreign))).toBeNull()
    const notAPerson = sessionFs({ issuer: ISSUER, accessToken: token("app_x") })
    expect(await headlessSyncSession(input(notAPerson))).toBeNull()
  })

  it("follows the account's binding, never a session of someone else", async () => {
    // Bound to Ann, but the session file now holds Bob: there is no Ann to act for.
    const swapped = sessionFs(
      { issuer: ISSUER, accessToken: token("usr_bob") },
      personFor("usr_ann")
    )
    expect(await headlessSyncSession(input(swapped))).toBeNull()
    // Signed out: the binding alone acts for nobody.
    expect(await headlessSyncSession(input(sessionFs(null, personFor("usr_ann"))))).toBeNull()
    // Bound to a self-hosted person: no official space.
    const selfHosted = sessionFs(
      { issuer: "https://logto.example/oidc", accessToken: token("usr_a") },
      personFor("usr_a", "https://logto.example/oidc")
    )
    expect(await headlessSyncSession(input(selfHosted))).toBeNull()
  })

  it("acts for the pinned person the Brain started with", async () => {
    const fs = sessionFs({ issuer: ISSUER, accessToken: token("usr_bob") }, personFor("usr_bob"))
    // The binding says Bob now (a --rebind ran), but this Brain started as Ann.
    const pinned = { ...input(fs), person: () => personFor("usr_ann") }
    expect(await headlessSyncSession(pinned)).toBeNull()
    fs.set({ issuer: ISSUER, accessToken: token("usr_ann") })
    expect((await headlessSyncSession(pinned))?.userId).toBe("usr_ann")
  })

  it("throws on an unreadable binding instead of calling the account signed out", async () => {
    const fs = sessionFs({ issuer: ISSUER, accessToken: token("usr_a") }, "garbage")
    await expect(headlessSyncSession(input(fs))).rejects.toThrow(/not a readable binding/)
  })

  it("is the person's space on the official account, and stops handing out tokens for someone else", async () => {
    const fs = sessionFs({ issuer: ISSUER, accessToken: token("usr_a") })
    const session = (await headlessSyncSession(
      input(fs, { COGNIA_SYNC_URL: "https://sync.test/" })
    ))!
    expect(session).toMatchObject({
      localAccountId: "local_acct_a",
      issuer: ISSUER,
      userId: "usr_a",
      spaceId: await spaceIdFor(ISSUER, "usr_a"),
      syncUrl: "https://sync.test",
    })
    expect(await session.accessToken()).toBe(token("usr_a"))
    fs.set({ issuer: ISSUER, accessToken: token("usr_b") })
    expect(await session.accessToken()).toBeNull()
  })
})

describe("brainBackup", () => {
  const filesystem = {} as never

  it("retries with a unique owned file after publication succeeds but history fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prejoin-backup-"))
    const filesystem = createNodeBackupFilesystem("persisted-brain-owner")
    writeEncryptedLocalBackup.mockImplementation(async (fs, target) => {
      await fs.writeTextFile(target, "committed encrypted backup")
      return { sizeBytes: 26 }
    })
    appendBackupHistory.mockRejectedValueOnce(new Error("transient_history_failure"))
    const backup = brainBackup({
      filesystem,
      fallbackDir: directory,
      now: () => new Date("2026-11-10T08:09:10.123Z"),
    })
    try {
      await expect(backup()).rejects.toThrow("transient_history_failure")
      await expect(backup()).resolves.toBeUndefined()
      await expect(backup()).resolves.toBeUndefined()
      const names = await fs.readdir(directory)
      expect(names).toHaveLength(3)
      for (const name of names) {
        expect(name).toMatch(
          /-prejoin-20261110T080910123Z-[a-f0-9-]{36}-owner-[a-f0-9]{64}\.enc\.cbk$/
        )
        expect(await fs.readFile(path.join(directory, name), "utf8")).toBe(
          "committed encrypted backup"
        )
      }
      const successes = appendBackupHistory.mock.calls
        .map(([row]) => row as { success: boolean; filename?: string })
        .filter((row) => row.success)
      expect(successes.map((row) => row.filename).sort()).toEqual(names.sort())
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("writes an encrypted backup into the scheduled folder and records it", async () => {
    getSettings.mockResolvedValue({ backupAutoSchedule: { dirPath: "/backups/" } })
    await brainBackup({
      filesystem,
      fallbackDir: "/srv/backups",
      now: () => new Date(Date.UTC(2026, 9, 6)),
    })()
    const [fsArg, target, options, passphrase] = writeEncryptedLocalBackup.mock.calls[0]!
    expect(fsArg).toBe(filesystem)
    expect(path.dirname(target as string)).toBe("/backups")
    expect(options).toEqual({ includeSessions: true, includeApiKey: false })
    expect(passphrase).toBe("pass")
    expect(appendBackupHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "auto",
        success: true,
        encryption: "auto-key",
        sizeBytes: 12,
      })
    )
  })

  it("falls back to the serve folder, and records and rethrows a failure", async () => {
    getDefaultBackupPassphrase.mockResolvedValue(null)
    await expect(brainBackup({ filesystem, fallbackDir: "/srv/backups" })()).rejects.toThrow(
      "the backup key of this host is unavailable"
    )
    expect(appendBackupHistory).toHaveBeenCalledWith(expect.objectContaining({ success: false }))

    getDefaultBackupPassphrase.mockResolvedValue("pass")
    await brainBackup({ filesystem, fallbackDir: "/srv/backups" })()
    expect(path.dirname(writeEncryptedLocalBackup.mock.calls.at(-1)![1] as string)).toBe(
      "/srv/backups"
    )
  })
})

describe("brainAccountSyncHost", () => {
  it("is absent while account sync is off, and otherwise shares the commands' store", async () => {
    const backup = jest.fn(async () => undefined)
    const base = {
      cliHome: HOME,
      localAccountId: "local_acct_a",
      backup,
      person: () => personFor("usr_a"),
    }
    expect(brainAccountSyncHost({ ...base, env: {} })).toBeUndefined()
    const host = brainAccountSyncHost({ ...base, env: { COGNIA_ACCOUNT_SYNC: "1" } })!
    expect(host.backup).toBe(backup)
    expect(typeof host.keyring.load).toBe("function")
    expect(accountSyncDir(HOME)).toBe(path.join(HOME, "account-sync"))
  })
})
