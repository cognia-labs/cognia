/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

jest.mock("./toggle-plugin-enabled", () => ({
  togglePluginEnabled: jest.fn(),
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isCapacitor: jest.fn(() => false),
}))
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: jest.fn(() => false),
}))
jest.mock("@/lib/plugin/analytics/record", () => ({
  PLUGIN_ANALYTIC_KEYS: { enabled: "lifecycle.enabled", disabled: "lifecycle.disabled" },
  recordPluginAnalytic: jest.fn(),
}))

import { togglePluginEnabled } from "./toggle-plugin-enabled"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { recordPluginAnalytic } from "@/lib/plugin/analytics/record"
import { isMirroredPluginClient, setPluginEnabledForHost } from "./set-plugin-enabled-for-host"

const mockToggle = togglePluginEnabled as jest.Mock
const mockIsCapacitor = isCapacitor as jest.Mock
const mockHasWebCompanionTarget = hasWebCompanionTarget as jest.Mock
const mockRecordAnalytic = recordPluginAnalytic as jest.Mock
import { mirrorViolations } from "@/lib/plugin/lifecycle/contract"
import { settleMirroredPluginToggle } from "./mirrored-toggle-receipt"
import { __resetDbForTesting, activateAccountDatabase, getDb } from "@/lib/db/schema"
import {
  clearActiveRuntimeTargetContext,
  getActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

const scope = { accountId: "acct_plugin_toggle", targetId: "host-a" }

beforeEach(async () => {
  mockToggle.mockReset().mockResolvedValue({ ok: true })
  mockIsCapacitor.mockReset().mockReturnValue(false)
  mockHasWebCompanionTarget.mockReset().mockReturnValue(false)
  mockRecordAnalytic.mockReset()
  activateAccountDatabase(scope.accountId, scope.targetId)
  setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
  await getDb().plugins.put({
    id: "p1",
    name: "Plugin 1",
    version: "1.0.0",
    status: "disabled",
    source: "local",
    type: "frontend",
    enabled: false,
    capabilities: [],
    path: "/plugins/p1",
    manifest: {},
    createdAt: 1,
    updatedAt: 1,
  })
})

afterEach(async () => {
  jest.restoreAllMocks()
  await getDb().delete()
  __resetDbForTesting()
  clearActiveRuntimeTargetContext()
})

describe("isMirroredPluginClient", () => {
  it("is false on a desktop or standalone browser", () => {
    expect(isMirroredPluginClient()).toBe(false)
  })

  it("is true on Capacitor", () => {
    mockIsCapacitor.mockReturnValue(true)
    expect(isMirroredPluginClient()).toBe(true)
  })

  it("is true for a browser paired to a cognia-server", () => {
    mockHasWebCompanionTarget.mockReturnValue(true)
    expect(isMirroredPluginClient()).toBe(true)
  })
})

describe("setPluginEnabledForHost", () => {
  it("drives the local manager when this host owns the runtime", async () => {
    const result = await setPluginEnabledForHost("p1", true)
    expect(mockToggle).toHaveBeenCalledWith("p1", true, "manual")
    expect(result).toEqual({ ok: true, queued: false })
    // The authority must never queue a job for itself. `discover-inspector`
    // used to do exactly that on desktop.
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
    expect(await getDb().plugins.get("p1")).toMatchObject({ enabled: false, updatedAt: 1 })
  })

  it("forwards the caller's reason to the manager", async () => {
    await setPluginEnabledForHost("p1", false, "batch")
    expect(mockToggle).toHaveBeenCalledWith("p1", false, "batch")
  })

  it("propagates a manager failure without claiming it was queued", async () => {
    mockToggle.mockResolvedValue({ ok: false, error: "activate failed" })
    await expect(setPluginEnabledForHost("p1", true)).resolves.toEqual({
      ok: false,
      queued: false,
      error: "activate failed",
    })
  })

  it("writes the mirror row and queues the host command on a companion", async () => {
    mockIsCapacitor.mockReturnValue(true)
    const result = await setPluginEnabledForHost("p1", true)
    expect(result).toEqual({ ok: true, queued: true })
    expect(await getDb().plugins.get("p1")).toMatchObject({ enabled: true })
    expect(await getDb().mobileOutboundQueue.toArray()).toEqual([
      expect.objectContaining({
        ...scope,
        command: "plugin_set_enabled",
        payload: { id: "p1", enabled: true },
      }),
    ])
    // A companion has no local runtime for the host's plugins, so calling the
    // manager there would silently do nothing.
    expect(mockToggle).not.toHaveBeenCalled()
  })

  it("labels the queued job machine-readably rather than with UI copy", async () => {
    mockHasWebCompanionTarget.mockReturnValue(true)
    await setPluginEnabledForHost("p1", false)
    expect(await getDb().mobileOutboundQueue.toArray()).toEqual([
      expect.objectContaining({ label: "plugin_set_enabled:p1:disabled" }),
    ])
  })

  it("reports a queue failure instead of throwing at the switch", async () => {
    mockIsCapacitor.mockReturnValue(true)
    jest.spyOn(getDb().mobileOutboundQueue, "put").mockRejectedValueOnce(new Error("queue full"))
    await expect(setPluginEnabledForHost("p1", true)).resolves.toEqual({
      ok: false,
      queued: true,
      error: "queue full",
    })
  })

  it.each(["target", "account", "generation"])(
    "B03: refuses an intent if the %s changes after the mirror update",
    async (change) => {
      mockIsCapacitor.mockReturnValue(true)
      const db = getDb()
      const update = db.plugins.update.bind(db.plugins)
      jest.spyOn(db.plugins, "update").mockImplementationOnce((key, changes) =>
        update(key, changes).then((count) => {
          setActiveRuntimeTargetContext(
            change === "account" ? "acct_other" : scope.accountId,
            change === "target" ? "host-b" : scope.targetId,
            change === "generation"
              ? getActiveRuntimeTargetContext()!.routingGeneration + 1
              : undefined
          )
          return count
        })
      )

      const result = await setPluginEnabledForHost("p1", true)
      const jobs = await db.mobileOutboundQueue.toArray()

      expect({ result, jobs }).toEqual({
        result: { ok: false, queued: true, error: expect.any(String) },
        jobs: [],
      })
      expect(await db.plugins.get("p1")).toMatchObject({ enabled: false, updatedAt: 1 })
    }
  )

  it("B03: rolls back both writes when the target changes during queue insertion", async () => {
    mockIsCapacitor.mockReturnValue(true)
    const db = getDb()
    const put = db.mobileOutboundQueue.put.bind(db.mobileOutboundQueue)
    jest.spyOn(db.mobileOutboundQueue, "put").mockImplementationOnce((row) =>
      put(row).then((id) => {
        setActiveRuntimeTargetContext(scope.accountId, "host-b")
        return id
      })
    )

    await expect(setPluginEnabledForHost("p1", true)).resolves.toMatchObject({ ok: false })
    expect(await db.plugins.get("p1")).toMatchObject({ enabled: false, updatedAt: 1 })
    expect(await db.mobileOutboundQueue.count()).toBe(0)
  })

  it("B03: leaves both databases untouched when the active account database changes", async () => {
    mockIsCapacitor.mockReturnValue(true)
    const db = getDb()
    const update = db.plugins.update.bind(db.plugins)
    jest.spyOn(db.plugins, "update").mockImplementationOnce((key, changes) =>
      update(key, changes).then((count) => {
        activateAccountDatabase("acct_other", "host-b")
        setActiveRuntimeTargetContext("acct_other", "host-b")
        return count
      })
    )

    try {
      await expect(setPluginEnabledForHost("p1", true)).resolves.toMatchObject({ ok: false })
      expect(await getDb().mobileOutboundQueue.count()).toBe(0)
      expect(await getDb().plugins.count()).toBe(0)
    } finally {
      await getDb().delete()
      activateAccountDatabase(scope.accountId, scope.targetId)
      setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
    }
    expect(await getDb().plugins.get("p1")).toMatchObject({ enabled: false, updatedAt: 1 })
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
  })

  it.each([true, false])(
    "B25: rolls back the mirror flag when enqueue rejects (enabled=%s)",
    async (next) => {
      mockIsCapacitor.mockReturnValue(true)
      const db = getDb()
      await db.plugins.update("p1", { enabled: !next })
      jest.spyOn(db.mobileOutboundQueue, "put").mockRejectedValueOnce(new Error("queue full"))

      await expect(setPluginEnabledForHost("p1", next)).resolves.toEqual({
        ok: false,
        queued: true,
        error: "queue full",
      })
      expect(await db.plugins.get("p1")).toMatchObject({ enabled: !next, updatedAt: 1 })
      expect(await db.mobileOutboundQueue.count()).toBe(0)
    }
  )

  it("B25: rolls back both writes when enqueue rejects after inserting", async () => {
    mockIsCapacitor.mockReturnValue(true)
    const db = getDb()
    const put = db.mobileOutboundQueue.put.bind(db.mobileOutboundQueue)
    jest.spyOn(db.mobileOutboundQueue, "put").mockImplementationOnce((row) =>
      put(row).then(() => {
        throw new Error("enqueue failed after insertion")
      })
    )

    await expect(setPluginEnabledForHost("p1", true)).resolves.toEqual({
      ok: false,
      queued: true,
      error: "enqueue failed after insertion",
    })
    expect(await db.plugins.get("p1")).toMatchObject({ enabled: false, updatedAt: 1 })
    expect(await db.mobileOutboundQueue.count()).toBe(0)
  })

  // `lib/db/plugin-analytics.ts` had zero importers, so nothing ever wrote a
  // row and Governance's Analytics view could only ever be empty. This is the
  // one place every enable/disable passes through.
  it("records the lifecycle transition for the analytics view", async () => {
    await setPluginEnabledForHost("p1", true)
    expect(mockRecordAnalytic).toHaveBeenCalledWith("p1", "lifecycle.enabled")
    await setPluginEnabledForHost("p1", false)
    expect(mockRecordAnalytic).toHaveBeenCalledWith("p1", "lifecycle.disabled")
  })

  it("records it on a companion too, where the host applies the change", async () => {
    mockIsCapacitor.mockReturnValue(true)
    await setPluginEnabledForHost("p1", true)
    expect(mockRecordAnalytic).toHaveBeenCalledWith("p1", "lifecycle.enabled")
  })
})

describe("ADR-0258 mirror clauses: capacitor-mirror", () => {
  it("queues the toggle, runs nothing here, and reads the Host's rows back once it answers", async () => {
    mockIsCapacitor.mockReturnValue(true)
    const result = await setPluginEnabledForHost("p1", true)
    const queuedRows = await getDb().mobileOutboundQueue.toArray()

    // The Host answers the queued job; the mirror reads its rows back.
    const pull = jest.fn(async () => [])
    await settleMirroredPluginToggle(
      { ok: true },
      {
        rewind: jest.fn(),
        pull,
        schedule: (run) => {
          run()
          return 1
        },
        cancel: jest.fn(),
      }
    )

    expect(queuedRows.map((row) => row.command)).toEqual(["plugin_set_enabled"])
    expect(
      mirrorViolations({
        // The toggle is the mirror's only lifecycle path; it never reaches a package.
        packageOperations: 0,
        localRuntimeCalls: mockToggle.mock.calls.length,
        reportedBeforeAnswer: !result.ok ? "failed" : result.queued ? "queued" : "applied",
        readBackAfterAnswer: pull.mock.calls.length === 1,
      })
    ).toEqual([])
  })
})
