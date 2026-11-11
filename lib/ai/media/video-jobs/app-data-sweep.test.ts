import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  __resetAccountContentCipherForTesting,
} from "@/lib/accounts/content-cipher"
import { encryptedRuntimeTargetDatabaseName } from "@/lib/runtime/target-registry"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import {
  databaseAppDataDir,
  GENERATED_VIDEO_APP_DATA_DIR,
  COMPOSER_VIDEO_STAGING_APP_DATA_DIR,
} from "@/lib/tauri/account-app-data"

const hostProfile = jest.fn(() => "desktop")
jest.mock("@/lib/platform/capabilities", () => ({ detectHostProfile: () => hostProfile() }))
let VIDEOS: string
let STAGING: string

// Files per directory, with their modification times.
const files = new Map<string, Map<string, number | null>>()
const directories = new Map<string, string[]>()
const heldOpen = new Set<string>()
const removeAppDataFile = jest.fn(async (path: string) => {
  if (heldOpen.has(path)) throw new Error("in use")
  const dir = path.split("/").slice(0, -1).join("/")
  files.get(dir)?.delete(path.split("/").at(-1)!)
})
const listAppDataDirectory = jest.fn(async (dir: string) => [
  ...[...(files.get(dir)?.keys() ?? [])].map((name) => ({
    name,
    isDirectory: false,
    isFile: true,
  })),
  ...(directories.get(dir) ?? []).map((name) => ({ name, isDirectory: true, isFile: false })),
])
const removeAppDataDirectory = jest.fn(async (_path: string) => undefined)
jest.mock("@/lib/tauri/app-data-files", () => ({
  removeAppDataFile: (path: string) => removeAppDataFile(path),
  removeAppDataDirectory: (path: string) => removeAppDataDirectory(path),
  listAppDataDirectory: (dir: string) => listAppDataDirectory(dir),
  appDataModifiedAt: async (path: string) => {
    const dir = path.split("/").slice(0, -1).join("/")
    const at = files.get(dir)?.get(path.split("/").at(-1)!)
    if (at === undefined) throw new Error("gone")
    return at
  },
}))

import { STALE_STAGING_MS, sweepVideoAppData, type VideoAppDataSweepDeps } from "./app-data-sweep"

const NOW = 10 * STALE_STAGING_MS
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
afterAll(fixture.dispose)

function deps(liveJobs: string[]): VideoAppDataSweepDeps {
  return {
    now: () => NOW,
    databaseExists: jest.fn(async () => true),
    existingJobIds: jest.fn(
      async (ids: readonly string[]) => new Set(ids.filter((id) => liveJobs.includes(id)))
    ),
  }
}

beforeEach(async () => {
  await fixture.restore()
  VIDEOS = databaseAppDataDir(GENERATED_VIDEO_APP_DATA_DIR, getActiveAccountId(), getDb().name)
  STAGING = databaseAppDataDir(
    COMPOSER_VIDEO_STAGING_APP_DATA_DIR,
    getActiveAccountId(),
    getDb().name
  )
  files.clear()
  directories.clear()
  heldOpen.clear()
  removeAppDataFile.mockClear()
  listAppDataDirectory.mockClear()
  removeAppDataDirectory.mockReset().mockResolvedValue(undefined)
  hostProfile.mockReturnValue("desktop")
})

describe("sweepVideoAppData", () => {
  it("removes generated videos no job row accounts for, and keeps a download in flight", async () => {
    files.set(
      VIDEOS,
      new Map([
        ["vjob_kept.mp4", NOW],
        ["vjob_orphan.mp4", NOW],
        ["vjob_downloading.mp4.1f2e.part", NOW],
      ])
    )
    const d = deps(["vjob_kept", "vjob_downloading"])
    const result = await sweepVideoAppData(d)
    expect(d.existingJobIds).toHaveBeenCalledWith(
      ["vjob_kept", "vjob_orphan", "vjob_downloading"],
      getDb()
    )
    expect([...files.get(VIDEOS)!.keys()]).toEqual([
      "vjob_kept.mp4",
      "vjob_downloading.mp4.1f2e.part",
    ])
    expect(result).toEqual({ databaseDirectories: 0, orphanVideos: 1, staleStagingCopies: 0 })
  })

  it("removes staging copies a crash left behind, and none still being prepared", async () => {
    files.set(
      STAGING,
      new Map<string, number | null>([
        ["old.mov", NOW - STALE_STAGING_MS - 1],
        ["fresh.mov", NOW - 1000],
        ["unknown.mov", null],
      ])
    )
    const result = await sweepVideoAppData(deps([]))
    expect([...files.get(STAGING)!.keys()]).toEqual(["fresh.mov", "unknown.mov"])
    expect(result.staleStagingCopies).toBe(1)
  })

  it("removes only dropped databases, and keeps an account directory when a child cannot be removed", async () => {
    directories.set(GENERATED_VIDEO_APP_DATA_DIR, ["acct_alpha"])
    directories.set(`${GENERATED_VIDEO_APP_DATA_DIR}/acct_alpha`, ["db-x", "db-held", "db-live"])
    const d = deps([])
    jest.mocked(d.databaseExists).mockImplementation(async (name) => name === "db-live")
    removeAppDataDirectory.mockImplementation(async (name) => {
      if (name.endsWith("db-held")) throw new Error("held open")
    })
    const report = { failed: 0, unknown: 0, skipped: false, removed: 0 }
    expect((await sweepVideoAppData(d, report)).databaseDirectories).toBe(1)
    expect(d.databaseExists).toHaveBeenCalledWith("db-x")
    expect(removeAppDataDirectory).not.toHaveBeenCalledWith(
      `${GENERATED_VIDEO_APP_DATA_DIR}/acct_alpha/db-live`
    )
    expect(removeAppDataDirectory).not.toHaveBeenCalledWith(
      `${GENERATED_VIDEO_APP_DATA_DIR}/acct_alpha`
    )
    expect(report).toMatchObject({ failed: 1, removed: 1 })
  })

  it("counts only what it removed; a file held open waits for the next sweep", async () => {
    files.set(VIDEOS, new Map([["vjob_orphan.mp4", NOW]]))
    heldOpen.add(`${VIDEOS}/vjob_orphan.mp4`)
    const report = { failed: 0, unknown: 0, skipped: false, removed: 0 }
    await expect(sweepVideoAppData(deps([]), report)).resolves.toMatchObject({ orphanVideos: 0 })
    expect(report.failed).toBe(1)
    expect(files.get(VIDEOS)!.has("vjob_orphan.mp4")).toBe(true)
  })

  it("does nothing off the desktop", async () => {
    hostProfile.mockReturnValue("mobile-companion")
    files.set(VIDEOS, new Map([["vjob_orphan.mp4", NOW]]))
    await expect(sweepVideoAppData(deps([]))).resolves.toEqual({
      databaseDirectories: 0,
      orphanVideos: 0,
      staleStagingCopies: 0,
    })
    expect(listAppDataDirectory).not.toHaveBeenCalled()
    expect(removeAppDataFile).not.toHaveBeenCalled()
  })

  it("uses the captured database to preserve a live job's video", async () => {
    files.set(VIDEOS, new Map([["live-job.mp4", NOW]]))
    await getDb().mediaGenerationJobs.put({ id: "live-job", status: "succeeded" } as never)
    await expect(sweepVideoAppData()).resolves.toMatchObject({ orphanVideos: 0 })
    expect(files.get(VIDEOS)?.has("live-job.mp4")).toBe(true)
    expect(removeAppDataFile).not.toHaveBeenCalled()
  })

  it("aborts without deleting a real video when listing switches to another database", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-video-scope-"))
    const video = path.join(root, "live-job.mp4")
    const sourceName = getDb().name
    await fs.writeFile(video, "live video")
    await getDb().mediaGenerationJobs.put({ id: "live-job", status: "succeeded" } as never)
    const account = "acct_other"
    const target = "target_other"
    const cipher = await AccountContentCipher.createForTesting(
      account,
      encryptedRuntimeTargetDatabaseName(account, target)
    )
    const listing = listAppDataDirectory.getMockImplementation()!
    listAppDataDirectory.mockImplementation(async (dir) => {
      if (dir !== VIDEOS) return listing(dir)
      activateAccountDatabase(account, target)
      activateAccountContentCipher(cipher)
      return [{ name: "live-job.mp4", isFile: true, isDirectory: false }]
    })
    removeAppDataFile.mockImplementationOnce(async () => {
      await fs.unlink(video)
    })
    try {
      await expect(sweepVideoAppData()).rejects.toThrow("video_sweep_owner_changed")
      expect(await fs.readFile(video, "utf8")).toBe("live video")
      expect(removeAppDataFile).not.toHaveBeenCalled()
      expect(removeAppDataDirectory).not.toHaveBeenCalled()
    } finally {
      await getDb().delete()
      clearAccountDatabaseSelection()
      __resetAccountContentCipherForTesting()
      listAppDataDirectory.mockImplementation(listing)
      removeAppDataFile.mockReset().mockImplementation(async (file) => {
        if (heldOpen.has(file)) throw new Error("in use")
        files.get(file.split("/").slice(0, -1).join("/"))?.delete(file.split("/").at(-1)!)
      })
      await fs.rm(root, { recursive: true, force: true })
    }
    expect(getDb().name).toBe(sourceName)
    expect(await getDb().mediaGenerationJobs.get("live-job")).toBeDefined()
  })

  it("aborts all planned deletions when the routing generation changes during job lookup", async () => {
    files.set(VIDEOS, new Map([["orphan.mp4", NOW]]))
    setActiveRuntimeTargetContext(getActiveAccountId(), "target_live", 1)
    const d = deps([])
    d.existingJobIds = jest.fn(async (_ids, db) => {
      expect(db).toBe(getDb())
      setActiveRuntimeTargetContext(getActiveAccountId(), "target_live", 2)
      return new Set<string>()
    })
    try {
      await expect(sweepVideoAppData(d)).rejects.toThrow("video_sweep_owner_changed")
      expect(removeAppDataFile).not.toHaveBeenCalled()
      expect(removeAppDataDirectory).not.toHaveBeenCalled()
    } finally {
      clearActiveRuntimeTargetContext()
    }
  })
})
