/**
 * Runs in the fast `node` project, NOT jsdom.
 *
 * This suite carried a `@jest-environment jsdom` docblock, and that is what
 * made it fail: forcing jsdom inside the node project makes the shared DB
 * fixture's full-schema capture transaction die with `PrematureCommitError`,
 * which Jest renders as an *empty* failure message. Nothing here needs a DOM —
 * every host dependency is injected — so the node default is both correct and
 * green. Do not re-add the docblock.
 */

import { createSiteEnvironmentRevision, createSiteProject } from "@/lib/db/sites"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  __resetSitePreviewsForTesting,
  getSitePreviewSession,
  resumeSitePreviewSession,
  startSitePreview,
  stopSitePreview,
} from "./preview"

// The shared fixture owns the schema open + seed. Hand-rolling
// `getDb().delete()` / `whenSeeded()` here used to race `seedBuiltIns()`'s own
// transactions, and the first `createSiteEnvironmentRevision` died with a
// `TransactionInactiveError` whose empty message made the failure unreadable.
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)

beforeEach(async () => {
  await dbFixture.restore()
  __resetSitePreviewsForTesting()
  await createSiteProject({
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    provider: "cloudflare",
    providerConfig: { accountId: "account", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "local-user", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
  })
})

async function environment() {
  return createSiteEnvironmentRevision({
    id: "env_1",
    siteId: "site_1",
    variables: { PUBLIC_ORIGIN: "https://example.com" },
    secretRefs: [],
  })
}

const manifest = JSON.stringify({
  schemaVersion: 1,
  build: { command: ["pnpm", "build"], entry: "dist/worker.js" },
  preview: { command: ["pnpm", "dev"], url: "http://localhost:3000" },
  cloudflare: { compatibilityDate: "2026-07-18", compatibilityFlags: [], bindings: [] },
})

/** `localStorage` stand-in; this suite runs in node, where there is none. */
function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    dump: () => Object.fromEntries(values),
  }
}

const OWNERSHIP_KEY = "cognia:sites:preview-terminals"

function hostDeps(storage = memoryStorage()) {
  return {
    join: async (...parts: string[]) => parts.join("/"),
    readText: async () => manifest,
    spawn: jest.fn(async (_input: unknown) => ({
      kind: "spawned" as const,
      sessionId: "terminal-1",
      shell: "pnpm",
    })),
    stop: jest.fn(async (_id: string) => undefined),
    waitUntilReady: jest.fn(async (_url: string) => undefined),
    osFamily: () => "macos" as const,
    storage,
  }
}

it("starts one terminal-backed preview, sandboxed with network, on this machine (A09, A11)", async () => {
  await environment()
  const deps = hostDeps()

  const first = await startSitePreview("site_1", "env_1", deps)
  const second = await startSitePreview("site_1", "env_1", deps)

  expect(second).toBe(first)
  expect(deps.spawn).toHaveBeenCalledTimes(1)
  const input = deps.spawn.mock.calls[0][0] as { req: Record<string, unknown>; local?: boolean }
  expect(input.req).toMatchObject({
    shell: "pnpm",
    args: ["dev"],
    cwd: "/repo/apps/docs",
    env: { PUBLIC_ORIGIN: "https://example.com" },
    origin: "local",
    sandboxed: true,
    // A dev server binds a loopback port and the host probes it: with the
    // network off the macOS profile refused the bind.
    sandboxNetwork: true,
    enableShellIntegration: false,
  })
  // Pinned to this machine's PTY: the readiness probe dials local `localhost`.
  expect(input.local).toBe(true)
  expect(deps.waitUntilReady).toHaveBeenCalledWith("http://localhost:3000")
})

it("refuses to start a preview on Windows, where the terminal sandbox does not exist (A11)", async () => {
  await environment()
  const deps = { ...hostDeps(), osFamily: () => "windows" as const }
  await expect(startSitePreview("site_1", "env_1", deps)).rejects.toThrow(
    "Site previews need the terminal sandbox"
  )
  expect(deps.spawn).not.toHaveBeenCalled()
})

it("kills a failed or explicitly stopped preview and releases its singleton", async () => {
  await environment()
  const storage = memoryStorage()
  const deps = hostDeps(storage)
  await expect(
    startSitePreview("site_1", "env_1", {
      ...deps,
      waitUntilReady: async () => {
        throw new Error("not ready")
      },
    })
  ).rejects.toThrow("not ready")
  expect(deps.stop).toHaveBeenCalledWith("terminal-1")
  // A preview that never became ready was never Sites' to resume.
  expect(storage.dump()[OWNERSHIP_KEY]).toBeUndefined()

  await startSitePreview("site_1", "env_1", deps)
  expect(JSON.parse(storage.dump()[OWNERSHIP_KEY])).toEqual({
    site_1: { terminalSessionId: "terminal-1", url: "http://localhost:3000" },
  })
  await stopSitePreview("site_1", { stop: deps.stop, storage })
  expect(getSitePreviewSession("site_1")).toBeUndefined()
  expect(JSON.parse(storage.dump()[OWNERSHIP_KEY])).toEqual({})
})

describe("resumeSitePreviewSession (F12)", () => {
  const owned = (record: Record<string, unknown>) =>
    memoryStorage({ [OWNERSHIP_KEY]: JSON.stringify(record) })

  it("re-adopts exactly the terminal Sites spawned, by id", async () => {
    const resumed = await resumeSitePreviewSession("site_1", {
      storage: owned({
        site_1: { terminalSessionId: "terminal-7", url: "http://localhost:3000" },
      }),
      listSessions: () => [
        { id: "terminal-3", projectId: "project_1", status: "running" },
        { id: "terminal-7", projectId: "project_1", status: "running" },
      ],
    })
    expect(resumed).toEqual({
      siteId: "site_1",
      terminalSessionId: "terminal-7",
      url: "http://localhost:3000",
    })
    expect(getSitePreviewSession("site_1")).toEqual(resumed)
  })

  it("never adopts an ordinary terminal open in the Site's folder", async () => {
    // The old match was project + cwd, which this terminal satisfies; Stop
    // then killed the user's own shell.
    const stop = jest.fn(async () => undefined)
    const resumed = await resumeSitePreviewSession("site_1", {
      storage: memoryStorage(),
      listSessions: () => [{ id: "user-shell", projectId: "project_1", status: "running" }],
    })
    expect(resumed).toBeUndefined()
    await stopSitePreview("site_1", { stop, storage: memoryStorage() })
    expect(stop).not.toHaveBeenCalled()
  })

  it("returns the already-tracked session without touching the terminal store", async () => {
    await environment()
    const deps = hostDeps()
    const first = await startSitePreview("site_1", "env_1", deps)
    const listSessions = jest.fn(() => [])
    await expect(
      resumeSitePreviewSession("site_1", { storage: deps.storage, listSessions })
    ).resolves.toBe(first)
    expect(listSessions).not.toHaveBeenCalled()
  })

  it("drops the record when its terminal exited, vanished or belongs to another project", async () => {
    for (const sessions of [
      [{ id: "terminal-7", projectId: "project_1", status: "exited" as const }],
      [],
      [{ id: "terminal-7", projectId: "project_2", status: "running" as const }],
    ]) {
      const storage = owned({
        site_1: { terminalSessionId: "terminal-7", url: "http://localhost:3000" },
      })
      await expect(
        resumeSitePreviewSession("site_1", { storage, listSessions: () => sessions })
      ).resolves.toBeUndefined()
      expect(JSON.parse(storage.dump()[OWNERSHIP_KEY])).toEqual({})
    }
    expect(getSitePreviewSession("site_1")).toBeUndefined()
  })

  it("treats a malformed record as no record", async () => {
    const listSessions = () => [
      { id: "terminal-7", projectId: "project_1", status: "running" as const },
    ]
    for (const raw of ["not json", "[]", JSON.stringify({ site_1: { terminalSessionId: 7 } })]) {
      await expect(
        resumeSitePreviewSession("site_1", {
          storage: memoryStorage({ [OWNERSHIP_KEY]: raw }),
          listSessions,
        })
      ).resolves.toBeUndefined()
    }
  })

  it("resolves to undefined for an unknown Site", async () => {
    await expect(
      resumeSitePreviewSession("missing", {
        storage: owned({ missing: { terminalSessionId: "t", url: "http://localhost:1" } }),
        listSessions: () => [{ id: "t", projectId: "project_1", status: "running" }],
      })
    ).resolves.toBeUndefined()
  })
})
