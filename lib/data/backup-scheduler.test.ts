/** @jest-environment node */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createNodeBackupFilesystem,
  getServeInstallationId,
} from "@/cli/src/serve/backup-filesystem"

let mockDatabase = { name: "account-a" }
jest.mock("@/lib/db/schema", () => ({ getDb: () => mockDatabase }))
jest.mock("./crypto", () => ({ sha256Hex: async (value: string) => `hash:${value}` }))
const mockGetSettings = jest.fn()
const mockSaveSettings = jest.fn(async (_input?: unknown) => undefined)
const mockAppendHistory = jest.fn(async (_input?: unknown) => undefined)
const mockGetLatestSuccessful = jest.fn(async (): Promise<unknown> => undefined)
const mockBuildPackage = jest.fn()
const mockBuildStream = jest.fn()
const mockDeviceMetadata = jest.fn<Promise<{ id: string } | null>, []>(async () => null)
jest.mock("@/lib/device/device-identity", () => ({
  getDeviceMetadata: () => mockDeviceMetadata(),
}))
jest.mock("./build-stream", () => ({
  buildBackupStream: (...args: unknown[]) => mockBuildStream(...args),
}))
const mockGetAutoKey = jest.fn(async (): Promise<string | null> => "auto-key")
const mockShouldRun = jest.fn((_input?: unknown): boolean => true)
const mockPrune = jest.fn()
const mockUpload = jest.fn()
const mockEncrypt = jest.fn(
  async (_plaintext?: unknown, _pkg?: unknown, _passphrase?: unknown) => "encrypted"
)
const mockHasSyncPassphrase = jest.fn(() => false)
const mockGetSyncPassphrase = jest.fn((): string | null => null)
const mockLoadPersistedSyncPassphrase = jest.fn(async () => false)
const mockNotifyRemoteNewer = jest.fn(async (_input?: unknown) => false)
const mockAttachPortableRetrievalKeys = jest.fn(
  async (value: unknown, _passphrase: string) => value
)

jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
  saveSettings: async (input: unknown) =>
    mockSaveSettings(typeof input === "function" ? input(await mockGetSettings()) : input),
}))
jest.mock("@/lib/db/backup-history", () => ({
  appendBackupHistory: (input: unknown) => mockAppendHistory(input),
  getLatestSuccessful: () => mockGetLatestSuccessful(),
}))
jest.mock("@/lib/data/build-package", () => ({
  buildBackupPackage: (options: unknown) => mockBuildPackage(options),
  serializePackage: () => "plain",
  defaultExportFileName: (...args: unknown[]) =>
    jest.requireActual("./build-package").defaultExportFileName(...args),
}))
jest.mock("@/lib/data/backup-key", () => ({
  getDefaultBackupPassphrase: () => mockGetAutoKey(),
}))
jest.mock("@/lib/data/retrieval-key-backup", () => ({
  attachPortableRetrievalKeys: (value: unknown, passphrase: string) =>
    mockAttachPortableRetrievalKeys(value, passphrase),
}))
jest.mock("@/lib/data/scheduler", () => ({
  shouldRunScheduledBackup: (input: unknown) => mockShouldRun(input),
  pruneScheduledBackups: (...args: unknown[]) => mockPrune(...args),
  scheduledBackupCompletedAt: (name: string) =>
    jest.requireActual("./scheduler").scheduledBackupCompletedAt(name),
}))
jest.mock("@/lib/data/destinations/webdav", () => ({
  encryptSnapshotBody: (plaintext: unknown, pkg: unknown, passphrase: unknown) =>
    mockEncrypt(plaintext, pkg, passphrase),
  uploadSnapshotToWebDav: (body: unknown, metadata: unknown) => mockUpload(body, metadata),
  webdavSnapshotName: () => "remote.enc.cbk",
}))
jest.mock("@/lib/webdav/passphrase-cache", () => ({
  getSyncPassphrase: () => mockGetSyncPassphrase(),
  setSyncPassphrase: jest.fn(),
  persistSyncPassphrase: jest.fn(async () => undefined),
  hasSyncPassphrase: () => mockHasSyncPassphrase(),
  loadPersistedSyncPassphrase: () => mockLoadPersistedSyncPassphrase(),
}))
jest.mock("@/lib/webdav/config", () => ({
  ...jest.requireActual("@/lib/webdav/config"),
  resolveWebDavConfig: async () => ({
    baseUrl: "https://dav.example.test",
    username: "test",
    password: "secret",
    remoteDir: "/cognia-backups",
  }),
}))
jest.mock("@/lib/webdav/remote-newer-notify", () => ({
  notifyIfRemoteNewer: (input: unknown) => mockNotifyRemoteNewer(input),
}))

import { defaultExportFileName } from "./build-package"

import {
  maybeUploadToWebDav,
  runScheduledBackupOnce,
  startBackupScheduler,
  writeEncryptedLocalBackup,
  type ScheduledBackupMessages,
} from "./backup-scheduler"

const messages: ScheduledBackupMessages = {
  missingDestination: "missing destination",
  autoKeyUnavailable: "missing auto key",
  syncPassphraseLocked: "sync locked",
  newerTitle: "newer",
  newerBody: "newer body",
}

function intervalFileName(now: Date, installationId?: string): string {
  return defaultExportFileName(now, "encrypted", installationId).replace(
    "-owner-",
    `-interval-${now.toISOString().replace(/[-:.]/g, "")}-owner-`
  )
}

const pkg = {
  manifest: {
    exportedAt: "2026-07-19T00:00:00.000Z",
    device: { id: "device-a", label: "Server A" },
  },
}

beforeEach(() => {
  mockDatabase = { name: "account-a" }
  mockDeviceMetadata.mockReset().mockResolvedValue(null)
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: {
      enabled: true,
      intervalDays: 1,
      retainCount: 2,
      dirPath: "/srv/backups",
    },
    webdavSync: { enabled: false },
  })
  mockBuildPackage.mockResolvedValue(pkg)
  mockGetAutoKey.mockResolvedValue("auto-key")
  mockShouldRun.mockReturnValue(true)
  mockPrune.mockImplementation((candidates) => candidates.slice(2))
  mockEncrypt.mockResolvedValue("encrypted")
  mockHasSyncPassphrase.mockReturnValue(false)
  mockGetSyncPassphrase.mockReturnValue(null)
  mockLoadPersistedSyncPassphrase.mockResolvedValue(false)
  mockAttachPortableRetrievalKeys.mockClear()
})

it("prunes earlier processes' backups using the persisted headless installation identity", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "backup-restarts-"))
  const directory = path.join(home, "backups")
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: { enabled: true, dirPath: directory, retainCount: 1 },
  })
  mockPrune.mockImplementation((...args) =>
    jest.requireActual("./scheduler").pruneScheduledBackups(...args)
  )
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode('{"manifest":{}}\n')
  })
  try {
    for (let restart = 1; restart <= 3; restart++) {
      // Neither the DB object nor the memory-backed device cache survives restart.
      mockDatabase = { name: "account-a" }
      mockDeviceMetadata.mockResolvedValue({ id: `process-${restart}` })
      const filesystem = createNodeBackupFilesystem(await getServeInstallationId(home))
      if (restart === 2) {
        const prejoin = defaultExportFileName(
          new Date(2026, 10, restart),
          "encrypted",
          filesystem.installationId
        ).replace("-owner-", "-prejoin-00000000-0000-4000-8000-000000000001-owner-")
        const foreign = defaultExportFileName(
          new Date(2026, 10, 1),
          "encrypted",
          "another-installation"
        ).replace("-owner-", "-prejoin-00000000-0000-4000-8000-000000000002-owner-")
        await fs.writeFile(path.join(directory, prejoin), "previous pre-join backup")
        await fs.writeFile(path.join(directory, foreign), "foreign backup")
      }
      await expect(
        runScheduledBackupOnce({
          filesystem,
          messages,
          now: () => new Date(2026, 10, restart),
        })
      ).resolves.toBe(true)
      const expected = intervalFileName(new Date(2026, 10, restart), filesystem.installationId)
      const ownerSuffix = expected.match(/-owner-[a-f0-9]{64}\.enc\.cbk$/)![0]
      const owned = (await fs.readdir(directory)).filter((name) => name.endsWith(ownerSuffix))
      expect(owned).toEqual([expected])
      expect((await fs.readdir(directory)).length).toBe(restart === 1 ? 1 : 2)
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

it("isolates two default-path Host volumes sharing a backup directory across restarts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-host-volumes-"))
  const directory = path.join(root, "shared-backups")
  const homes = ["host-a", "host-b"].map((volume) => path.join(root, volume, "data", "serve"))
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: { enabled: true, dirPath: directory, retainCount: 1 },
  })
  mockPrune.mockImplementation((...args) =>
    jest.requireActual("./scheduler").pruneScheduledBackups(...args)
  )
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode('{"manifest":{}}\n')
  })
  try {
    const identities = await Promise.all(homes.map(getServeInstallationId))
    expect(identities[0]).not.toBe(identities[1])
    const expected = new Map<number, string>()
    for (const [host, day] of [
      [0, 1],
      [1, 2],
      [0, 3],
      [1, 4],
    ] as const) {
      // Each volume is mounted as /data/serve in its Host; account and DB names match.
      mockDatabase = { name: "cognia-encrypted-local_acct_a" }
      const identity = await getServeInstallationId(homes[host]!)
      expect(identity).toBe(identities[host])
      const filesystem = createNodeBackupFilesystem(identity)
      const now = new Date(2026, 10, day)
      expect(await runScheduledBackupOnce({ filesystem, messages, now: () => now })).toBe(true)
      expected.set(host, intervalFileName(now, identity))
      expect((await fs.readdir(directory)).sort()).toEqual([...expected.values()].sort())
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

it("retains the newer same-day pre-join point when UUIDs sort opposite to creation time", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "backup-prejoin-time-"))
  const identity = "installation-a"
  const now = new Date("2026-11-10T12:00:00.789Z")
  const current = intervalFileName(now, identity)
  const baseName = defaultExportFileName(now, "encrypted", identity)
  const older = baseName.replace(
    "-owner-",
    "-prejoin-20261110T090000123Z-ffffffff-ffff-4fff-bfff-ffffffffffff-owner-"
  )
  const newer = baseName.replace(
    "-owner-",
    "-prejoin-20261110T100000456Z-00000000-0000-4000-8000-000000000000-owner-"
  )
  const legacy = defaultExportFileName(new Date("2026-11-09T00:00:00Z"), "encrypted", identity)
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: { enabled: true, dirPath: directory, retainCount: 2 },
  })
  mockPrune.mockImplementation((...args) =>
    jest.requireActual("./scheduler").pruneScheduledBackups(...args)
  )
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode('{"manifest":{}}\n')
  })
  try {
    for (const file of [older, newer, legacy])
      await fs.writeFile(path.join(directory, file), "recovery point")
    const filesystem = createNodeBackupFilesystem(identity)
    expect(await runScheduledBackupOnce({ filesystem, messages, now: () => now })).toBe(true)
    expect((await fs.readdir(directory)).sort()).toEqual([current, newer].sort())
    expect(mockPrune).toHaveBeenCalledWith(
      expect.arrayContaining([
        { name: path.join(directory, older), completedAt: Date.parse("2026-11-10T09:00:00.123Z") },
        { name: path.join(directory, newer), completedAt: Date.parse("2026-11-10T10:00:00.456Z") },
      ]),
      2,
      path.join(directory, current)
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

it("retains the 01:00 pre-join over the 00:30 interval when the next day's interval runs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "backup-local-day-"))
  const filesystem = createNodeBackupFilesystem("installation-a")
  const interval = new Date(2026, 10, 11, 0, 30)
  const prejoin = new Date(2026, 10, 11, 1)
  const nextDay = new Date(2026, 10, 12, 0, 30)
  const prejoinName = defaultExportFileName(
    prejoin,
    "encrypted",
    filesystem.installationId
  ).replace(
    "-owner-",
    `-prejoin-${prejoin.toISOString().replace(/[-:.]/g, "")}-ffffffff-ffff-4fff-bfff-ffffffffffff-owner-`
  )
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: { enabled: true, dirPath: directory, retainCount: 2 },
  })
  mockPrune.mockImplementation((...args) =>
    jest.requireActual("./scheduler").pruneScheduledBackups(...args)
  )
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode('{"manifest":{}}\n')
  })
  try {
    expect(await runScheduledBackupOnce({ filesystem, messages, now: () => interval })).toBe(true)
    expect(await fs.readdir(directory)).toEqual([
      intervalFileName(interval, filesystem.installationId),
    ])
    await fs.writeFile(path.join(directory, prejoinName), "pre-join recovery point")
    expect(await runScheduledBackupOnce({ filesystem, messages, now: () => nextDay })).toBe(true)
    expect((await fs.readdir(directory)).sort()).toEqual(
      [prejoinName, intervalFileName(nextDay, filesystem.installationId)].sort()
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

it("streams encrypted scheduled backups without constructing a legacy package", async () => {
  const chunks = [
    new TextEncoder().encode(JSON.stringify({ manifest: { device: { id: "device-a" } } }) + "\n"),
    new TextEncoder().encode("encrypted-chunk\n"),
  ]
  mockBuildStream.mockImplementation(async function* () {
    yield* chunks
  })
  const filesystem = {
    writeTextFile: jest.fn(),
    readDirNames: jest.fn(async () => []),
    remove: jest.fn(),
    writeStream: jest.fn(async (_target: string, source: AsyncIterable<Uint8Array>) => {
      let size = 0
      for await (const chunk of source) size += chunk.byteLength
      return size
    }),
  }
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(true)
  expect(mockBuildPackage).not.toHaveBeenCalled()
  expect(filesystem.writeTextFile).not.toHaveBeenCalled()
  expect(mockBuildStream).toHaveBeenCalledWith(
    { includeSessions: true, includeApiKey: false },
    { encryption: { passphrase: "auto-key" } }
  )
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({
      success: true,
      deviceId: "device-a",
      sizeBytes: chunks.reduce((sum, value) => sum + value.byteLength, 0),
    })
  )
})

it("stops generating stream chunks when a scheduled task is cancelled", async () => {
  const controller = new AbortController()
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode('{"manifest":{}}\n')
    controller.abort()
    yield new Uint8Array([1])
  })
  const chunks: Uint8Array[] = []
  await expect(
    writeEncryptedLocalBackup(
      {
        writeTextFile: jest.fn(),
        readDirNames: jest.fn(),
        remove: jest.fn(),
        writeStream: async (_path, source) => {
          for await (const chunk of source) chunks.push(chunk)
          return 1
        },
      },
      "target",
      { includeSessions: true, includeApiKey: false },
      "pass",
      controller.signal
    )
  ).rejects.toThrow()
  expect(chunks).toHaveLength(1)
})

it("retains a completed local stream when the remote package exceeds its size limit", async () => {
  mockGetSyncPassphrase.mockReturnValue("sync-passphrase")
  mockHasSyncPassphrase.mockReturnValue(true)
  mockPrune.mockReturnValue([])
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: { enabled: true, dirPath: "/srv/backups", retainCount: 2 },
    webdavSync: { enabled: true },
  })
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode('{"manifest":{}}\n')
  })
  mockBuildPackage.mockRejectedValueOnce(new Error("backup_requires_streaming_export"))
  const filesystem = {
    writeTextFile: jest.fn(),
    readDirNames: jest.fn(async () => []),
    remove: jest.fn(),
    writeStream: async (_path: string, source: AsyncIterable<Uint8Array>) => {
      let size = 0
      for await (const chunk of source) size += chunk.byteLength
      return size
    },
  }
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(true)
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({ success: true, encryption: "auto-key" })
  )
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({ success: false, errorMessage: "backup_requires_streaming_export" })
  )
  expect(mockUpload).not.toHaveBeenCalled()
  expect(filesystem.remove).not.toHaveBeenCalled()
})

afterEach(() => {
  jest.useRealTimers()
})

it("uses stable, filesystem-safe names for each account and target", () => {
  const now = new Date(2026, 10, 10, 12)
  const names = [
    "cognia-account-acct_alpha-target-target_one-encrypted-v1",
    "cognia-account-acct_beta-target-target_one-encrypted-v1",
    "cognia-account-acct_alpha-target-target_two-encrypted-v1",
  ].map((name) => {
    mockDatabase = { name }
    const fileName = defaultExportFileName(now, "encrypted")
    expect(fileName).toBe(defaultExportFileName(now, "encrypted"))
    expect(fileName).toMatch(/^cognia-backup-2026-11-10-owner-[a-f0-9]{64}\.enc\.cbk$/)
    expect(fileName).not.toContain("acct_")
    expect(fileName).not.toContain("target_")
    return fileName
  })
  expect(new Set(names).size).toBe(3)
})

it("writes, prunes, records, and stamps one encrypted scheduled backup through the injected host filesystem", async () => {
  const filesystem = {
    writeTextFile: jest.fn(async () => undefined),
    readDirNames: jest.fn(async () => [
      intervalFileName(new Date("2026-07-19T00:00:00Z")),
      defaultExportFileName(new Date("2026-07-18T00:00:00Z"), "encrypted"),
      defaultExportFileName(new Date("2026-07-17T00:00:00Z"), "encrypted"),
      "cognia-backup-2026-07-16.enc.cbk",
      "notes.txt",
    ]),
    remove: jest.fn(async () => undefined),
  }

  await expect(
    runScheduledBackupOnce({
      filesystem,
      messages,
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    })
  ).resolves.toBe(true)

  expect(filesystem.writeTextFile).toHaveBeenCalledWith(
    `/srv/backups/${intervalFileName(new Date("2026-07-19T00:00:00Z"))}`,
    "encrypted"
  )
  expect(filesystem.remove).toHaveBeenCalledWith(
    `/srv/backups/${defaultExportFileName(new Date("2026-07-17T00:00:00Z"), "encrypted")}`
  )
  expect(filesystem.remove).toHaveBeenCalledTimes(1)
  expect(mockAttachPortableRetrievalKeys).toHaveBeenCalledWith(pkg, "auto-key")
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "scheduled",
      success: true,
      encryption: "auto-key",
      filename: intervalFileName(new Date("2026-07-19T00:00:00Z")),
      deviceId: "device-a",
    })
  )
  expect(mockSaveSettings).toHaveBeenCalledWith({
    backupAutoSchedule: expect.objectContaining({
      lastRunAt: expect.any(String),
      lastLocalRun: expect.objectContaining({
        directory: "/srv/backups",
        content: "interval-full-v1",
      }),
    }),
  })
})

it("records a translated failure when the host has no writable destination", async () => {
  await expect(runScheduledBackupOnce({ filesystem: null, messages })).resolves.toBe(false)
  expect(mockBuildPackage).not.toHaveBeenCalled()
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({ success: false, errorMessage: "missing destination" })
  )
})

it("isolates scheduled files and retention for different installations of the same target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-backup-devices-"))
  const now = new Date(2026, 10, 10, 12)
  const old = new Date(2026, 10, 9, 12)
  const filesystem = createNodeBackupFilesystem()
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: {
      enabled: true,
      intervalDays: 1,
      dirPath: root,
      retainCount: 1,
    },
  })
  mockPrune.mockImplementation((...args) =>
    jest.requireActual("./scheduler").pruneScheduledBackups(...args)
  )
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode('{"manifest":{}}')
  })
  try {
    mockDeviceMetadata.mockResolvedValue({ id: "device-one" })
    expect(await runScheduledBackupOnce({ filesystem, messages, now: () => now })).toBe(true)
    const first = intervalFileName(now, "device-one")
    const oldFirst = defaultExportFileName(old, "encrypted", "device-one")
    await fs.writeFile(path.join(root, oldFirst), "first device older backup")
    mockDeviceMetadata.mockResolvedValue({ id: "device-two" })
    const second = intervalFileName(now, "device-two")
    const oldSecond = defaultExportFileName(old, "encrypted", "device-two")
    await fs.writeFile(path.join(root, oldSecond), "second device older backup")
    expect(await runScheduledBackupOnce({ filesystem, messages, now: () => now })).toBe(true)
    expect(await filesystem.readDirNames(root)).toEqual(
      expect.arrayContaining([first, oldFirst, second])
    )
    await expect(fs.stat(path.join(root, oldSecond))).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

it("keeps other owners and legacy backups while pruning only this owner's files on disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-backup-owners-"))
  const now = new Date(2026, 10, 10, 12)
  const old = new Date(2026, 10, 9, 12)
  const filesystem = createNodeBackupFilesystem()
  const legacy = path.join(root, "cognia-backup-2026-11-09.enc.cbk")
  const ownerA = { name: "cognia-account-acct_alpha-target-target_one-encrypted-v1" }
  const ownerB = { name: "cognia-account-acct_beta-target-target_two-encrypted-v1" }
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: {
      enabled: true,
      intervalDays: 1,
      dirPath: root,
      retainCount: 1,
    },
  })
  mockPrune.mockImplementation((...args) =>
    jest.requireActual("./scheduler").pruneScheduledBackups(...args)
  )
  mockBuildStream.mockImplementation(async function* () {
    yield new TextEncoder().encode(
      JSON.stringify({ manifest: { device: { id: mockDatabase.name } } })
    )
  })
  try {
    await fs.writeFile(legacy, "legacy backup")
    mockDatabase = ownerB
    const bName = intervalFileName(now)
    const bOld = defaultExportFileName(old, "encrypted")
    await fs.writeFile(path.join(root, bOld), "other owner's older backup")
    expect(await runScheduledBackupOnce({ filesystem, messages, now: () => now })).toBe(true)
    const bContents = await fs.readFile(path.join(root, bName), "utf8")
    // Recreate an older file to ensure A's retention cannot remove it.
    await fs.writeFile(path.join(root, bOld), "other owner's older backup")
    mockDatabase = ownerA
    const aName = intervalFileName(now)
    const aOld = defaultExportFileName(old, "encrypted")
    await fs.writeFile(path.join(root, aOld), "this owner's older backup")
    expect(await runScheduledBackupOnce({ filesystem, messages, now: () => now })).toBe(true)
    expect(aName).not.toBe(bName)
    expect(await fs.readFile(path.join(root, bName), "utf8")).toBe(bContents)
    expect(await fs.readFile(path.join(root, bOld), "utf8")).toBe("other owner's older backup")
    expect(await fs.readFile(legacy, "utf8")).toBe("legacy backup")
    await expect(fs.stat(path.join(root, aOld))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await fs.readFile(path.join(root, aName), "utf8")).toContain(ownerA.name)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

it("does nothing while disabled or before the configured interval is due", async () => {
  mockGetSettings.mockResolvedValueOnce({ backupAutoSchedule: { enabled: false } })
  await expect(runScheduledBackupOnce({ filesystem: null, messages })).resolves.toBe(false)

  mockShouldRun.mockReturnValueOnce(false)
  await expect(runScheduledBackupOnce({ filesystem: null, messages })).resolves.toBe(false)
  expect(mockAppendHistory).not.toHaveBeenCalled()
})

it("ignores ambiguous legacy, manual, cron and remote history when determining interval cadence", async () => {
  mockShouldRun.mockReturnValue(false)
  mockGetLatestSuccessful.mockResolvedValue({
    type: "scheduled",
    destination: "webdav",
    completedAt: Date.now(),
  })
  await runScheduledBackupOnce({ filesystem: null, messages })
  expect(mockGetLatestSuccessful).not.toHaveBeenCalled()
  expect(mockShouldRun).toHaveBeenLastCalledWith(
    expect.objectContaining({ lastSuccessAt: undefined })
  )
})

it("uses durable scoped progress even without history, and reruns for a different directory/host", async () => {
  const completedAt = Date.now() - 60_000
  const config = {
    enabled: true,
    intervalDays: 1,
    dirPath: "/srv/backups",
    retainCount: 2,
    lastLocalRun: {
      scope: "hash:account-a:auto-key",
      directory: "/srv/backups",
      content: "interval-full-v1",
      completedAt,
    },
  }
  mockShouldRun.mockImplementation((input) =>
    jest.requireActual("./scheduler").shouldRunScheduledBackup(input)
  )
  mockGetSettings.mockResolvedValue({ backupAutoSchedule: config })
  await expect(runScheduledBackupOnce({ filesystem: null, messages })).resolves.toBe(false)
  expect(mockAppendHistory).not.toHaveBeenCalled()
  mockGetSettings.mockResolvedValue({ backupAutoSchedule: { ...config, dirPath: "/new" } })
  await runScheduledBackupOnce({ filesystem: null, messages })
  expect(mockAppendHistory).toHaveBeenCalledTimes(1)
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: {
      ...config,
      lastLocalRun: { ...config.lastLocalRun, scope: "other-host" },
    },
  })
  await runScheduledBackupOnce({ filesystem: null, messages })
  expect(mockAppendHistory).toHaveBeenCalledTimes(2)
})

it("serializes distinct local requests and checks cancellation after waiting", async () => {
  let release!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    release = resolve
  })
  const filesystem = {
    writeTextFile: jest
      .fn()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined),
    readDirNames: jest.fn(),
    remove: jest.fn(),
  }
  const first = writeEncryptedLocalBackup(
    filesystem,
    "same",
    { includeSessions: true, includeApiKey: false },
    "pass"
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const controller = new AbortController()
  const cancelled = writeEncryptedLocalBackup(
    filesystem,
    "same",
    { includeSessions: false, includeApiKey: false },
    "pass",
    controller.signal
  )
  const rejected = expect(cancelled).rejects.toThrow()
  const distinct = writeEncryptedLocalBackup(
    filesystem,
    "same",
    { includeSettings: true, includeSessions: true, includeApiKey: false },
    "pass"
  )
  controller.abort()
  expect(filesystem.writeTextFile).toHaveBeenCalledTimes(1)
  release()
  await first
  await rejected
  await distinct
  expect(filesystem.writeTextFile).toHaveBeenCalledTimes(2)
  expect(mockBuildPackage).toHaveBeenCalledWith({
    includeSettings: true,
    includeSessions: true,
    includeApiKey: false,
  })
})

it("does not record or upload another account's data after a switch during retention", async () => {
  mockGetSettings.mockResolvedValue({
    backupAutoSchedule: { enabled: true, dirPath: "/srv/backups", intervalDays: 1, retainCount: 2 },
    webdavSync: { enabled: true },
  })
  const filesystem = {
    writeTextFile: jest.fn(),
    remove: jest.fn(),
    readDirNames: jest.fn(async () => {
      mockDatabase = { name: "account-b" }
      return []
    }),
  }
  await expect(runScheduledBackupOnce({ filesystem, messages })).rejects.toThrow(
    "backup_owner_changed"
  )
  expect(mockAppendHistory).not.toHaveBeenCalled()
  expect(mockUpload).not.toHaveBeenCalled()
})

it("keeps a completed backup valid when retention cleanup and metadata stamping fail", async () => {
  const filesystem = {
    writeTextFile: jest.fn(async () => undefined),
    readDirNames: jest.fn(async () => ["old.enc.cbk"]),
    remove: jest.fn(async () => {
      throw new Error("retention denied")
    }),
  }
  mockSaveSettings.mockRejectedValueOnce(new Error("settings locked"))

  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(true)
  expect(mockAppendHistory).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
})

it("treats directory enumeration as best-effort and records write/key failures", async () => {
  const filesystem = {
    writeTextFile: jest.fn(async () => undefined),
    readDirNames: jest.fn(async () => {
      throw new Error("cannot enumerate")
    }),
    remove: jest.fn(async () => undefined),
  }
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(true)

  mockGetAutoKey.mockResolvedValueOnce(null)
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(false)
  expect(mockAppendHistory).toHaveBeenCalledWith(
    expect.objectContaining({ success: false, errorMessage: "missing auto key" })
  )

  mockBuildPackage.mockRejectedValueOnce("package failed")
  await expect(runScheduledBackupOnce({ filesystem, messages })).resolves.toBe(false)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "package failed" })
  )
})

it("normalizes Windows destinations and sorts multiple retention candidates", async () => {
  const now = new Date("2026-11-11T00:00:00.123Z")
  mockGetSettings.mockResolvedValueOnce({
    backupAutoSchedule: {
      enabled: true,
      intervalDays: 1,
      retainCount: 2,
      dirPath: "C:\\backups\\",
    },
    webdavSync: { enabled: false },
  })
  const filesystem = {
    writeTextFile: jest.fn(async () => undefined),
    readDirNames: jest.fn(async () => ["b.enc.cbk", "a.enc.cbk", "c.enc.cbk"]),
    remove: jest.fn(async () => undefined),
  }

  await runScheduledBackupOnce({ filesystem, messages, now: () => now })
  expect(filesystem.writeTextFile).toHaveBeenCalledWith(
    `C:\\backups\\${intervalFileName(now)}`,
    "encrypted"
  )
})

it("preserves every WebDAV outcome in backup history", async () => {
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "sync locked" })
  )

  mockHasSyncPassphrase.mockReturnValue(true)
  mockGetSyncPassphrase.mockReturnValue("sync-passphrase")
  mockUpload.mockResolvedValueOnce({ ok: true, remotePath: "/cognia-backups/remote.enc.cbk" })
  mockGetSettings.mockResolvedValueOnce({ webdavSync: { enabled: true } })
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockSaveSettings).toHaveBeenLastCalledWith({
    webdavSync: expect.objectContaining({ enabled: true, lastSyncAt: expect.any(String) }),
  })
  expect(mockAttachPortableRetrievalKeys).toHaveBeenLastCalledWith(pkg, "sync-passphrase")

  mockUpload.mockResolvedValueOnce({ ok: false, error: "remote unavailable" })
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "remote unavailable" })
  )

  mockEncrypt.mockRejectedValueOnce("encryption failed")
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "encryption failed" })
  )

  mockEncrypt.mockRejectedValueOnce(new Error("cipher unavailable"))
  await maybeUploadToWebDav(true, pkg as never, "plain", messages)
  expect(mockAppendHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ success: false, errorMessage: "cipher unavailable" })
  )
})

it("runs immediately, repeats on the configured interval, and tears down cleanly", async () => {
  jest.useFakeTimers()
  mockGetSettings.mockResolvedValue({ backupAutoSchedule: { enabled: false } })
  const log = jest.fn()
  const stop = startBackupScheduler({ filesystem: null, messages, intervalMs: 50, log })

  await jest.advanceTimersByTimeAsync(0)
  expect(mockLoadPersistedSyncPassphrase).toHaveBeenCalledTimes(1)

  await jest.advanceTimersByTimeAsync(50)
  expect(mockLoadPersistedSyncPassphrase).toHaveBeenCalledTimes(2)
  expect(mockNotifyRemoteNewer).toHaveBeenCalled()

  stop()
  expect(jest.getTimerCount()).toBe(0)

  mockLoadPersistedSyncPassphrase.mockRejectedValueOnce(new Error("keyring unavailable"))
  const stopAfterError = startBackupScheduler({ filesystem: null, messages, intervalMs: 50, log })
  await jest.advanceTimersByTimeAsync(0)
  expect(log).toHaveBeenCalledWith("warn", "keyring unavailable")
  stopAfterError()

  mockLoadPersistedSyncPassphrase.mockRejectedValueOnce("keyring locked")
  const stopAfterStringError = startBackupScheduler({ filesystem: null, messages, log })
  await jest.advanceTimersByTimeAsync(0)
  expect(log).toHaveBeenCalledWith("warn", "keyring locked")
  stopAfterStringError()
})

it("fans interval backups through the registry, preserves producer/readiness, and keeps local success on remote failure", async () => {
  const { registerBackupDestination } = await import("./destinations/registry")
  mockGetSyncPassphrase.mockReturnValue("sync-passphrase")
  mockEncrypt.mockResolvedValue(
    JSON.stringify({ version: "enc-v1", kdf: {}, ciphertext: "ciphertext" })
  )
  const upload = jest.fn(async () => ({ remoteId: "one", bytes: 42 }))
  const unreadyUpload = jest.fn()
  const failedUpload = jest.fn(async () => {
    throw new Error("quota")
  })
  const disposers = [
    registerBackupDestination(
      { id: "ready", label: "Ready", readiness: async () => ({ state: "ready" }), upload },
      { pluginId: "interval", declarations: [{ id: "ready", label: "Ready" }] }
    ),
    registerBackupDestination(
      {
        id: "locked",
        label: "Locked",
        readiness: async () => ({ state: "needs-auth", reasonKey: "signIn" }),
        upload: unreadyUpload,
      },
      { pluginId: "interval", declarations: [{ id: "locked", label: "Locked" }] }
    ),
    registerBackupDestination(
      {
        id: "failed",
        label: "Failed",
        readiness: async () => ({ state: "ready" }),
        upload: failedUpload,
      },
      { pluginId: "interval", declarations: [{ id: "failed", label: "Failed" }] }
    ),
  ]
  try {
    expect(
      await runScheduledBackupOnce({
        filesystem: {
          writeTextFile: jest.fn(async () => undefined),
          readDirNames: async () => [],
          remove: async () => undefined,
        },
        messages,
      })
    ).toBe(true)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(unreadyUpload).not.toHaveBeenCalled()
    expect(failedUpload).toHaveBeenCalledTimes(1)
    expect(mockUpload).not.toHaveBeenCalled() // disabled built-in interval destination
    expect(mockAppendHistory).toHaveBeenCalledWith(
      expect.objectContaining({ destination: "local", success: true, producer: "interval" })
    )
    const pluginRows = (destination: string) =>
      mockAppendHistory.mock.calls
        .map(([row]) => row as { destination?: string })
        .filter((row) => row.destination === destination)
    expect(pluginRows("plugin:interval/ready")).toEqual([
      expect.objectContaining({
        destination: "plugin:interval/ready",
        success: true,
        producer: "interval",
        result: expect.objectContaining({ status: "success" }),
      }),
    ])
    expect(pluginRows("plugin:interval/locked")).toEqual([
      expect.objectContaining({
        destination: "plugin:interval/locked",
        success: false,
        producer: "interval",
        result: { status: "skipped", reasonKey: "signIn" },
      }),
    ])
    expect(pluginRows("plugin:interval/failed")).toEqual([
      expect.objectContaining({
        destination: "plugin:interval/failed",
        success: false,
        producer: "interval",
        errorMessage: "quota",
        result: { status: "failed" },
      }),
    ])
  } finally {
    for (const dispose of disposers) dispose()
  }
})
