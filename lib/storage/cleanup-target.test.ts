import "fake-indexeddb/auto"
import { activateAccountDatabase, clearAccountDatabaseSelection } from "@/lib/db/schema"
import { isTauri } from "@/lib/platform/detect"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { RuntimeTargetRegistry } from "@/lib/runtime/target-registry"
import { getCleanupTargetKey, readCleanupOwnership } from "./cleanup-target"

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))

afterEach(() => {
  clearAccountDatabaseSelection()
  clearActiveRuntimeTargetContext()
  jest.mocked(isTauri).mockReturnValue(false)
})

it("binds confirmations to database name and the target's activation generation", () => {
  setActiveRuntimeTargetContext("storage-binding", "web-standalone")
  activateAccountDatabase("storage-binding", "web-standalone")
  const first = getCleanupTargetKey()
  activateAccountDatabase("storage-binding", "host-other")
  expect(getCleanupTargetKey()).not.toBe(first)
  setActiveRuntimeTargetContext("storage-binding", "host-other")
  activateAccountDatabase("storage-binding", "web-standalone")
  setActiveRuntimeTargetContext("storage-binding", "web-standalone")
  expect(getCleanupTargetKey()).not.toBe(first)
  expect(getCleanupTargetKey()).toBe(getCleanupTargetKey())
})

it("preserves the binding when activation only re-primes the same database identity", () => {
  setActiveRuntimeTargetContext("storage-binding", "web-standalone")
  activateAccountDatabase("storage-binding", "web-standalone")
  const first = getCleanupTargetKey()
  activateAccountDatabase("storage-binding", "web-standalone")
  expect(getCleanupTargetKey()).toBe(first)
})

it("leaves a legacy mobile mirror's ownership unknown", async () => {
  activateAccountDatabase("storage-mobile")
  setActiveRuntimeTargetContext("storage-mobile", "mobile-companion")
  expect((await readCleanupOwnership("cognia-account-storage-mobile-encrypted-v1")).kind).toBe(
    "unknown"
  )
})

it("uses row ownership for the native desktop's account DB independently of its selected Host", async () => {
  jest.mocked(isTauri).mockReturnValue(true)
  activateAccountDatabase("storage-desktop")
  setActiveRuntimeTargetContext("storage-desktop", "local-host")
  expect((await readCleanupOwnership("cognia-account-storage-desktop-encrypted-v1")).kind).toBe(
    "session-rows"
  )
})

it.each(["missing", "unreadable", "wrong-database", "wrong-pointer"])(
  "fails closed for a %s owner",
  async (scenario) => {
    const registry = new RuntimeTargetRegistry()
    const accountId = `storage-${scenario}`
    const target = await registry.ensureStandaloneTarget(accountId)
    await registry.activateTarget(accountId, target.id)
    activateAccountDatabase(accountId, target.id)
    setActiveRuntimeTargetContext(accountId, target.id)
    const database = `cognia-account-${accountId}-target-${target.id}-encrypted-v1`
    let read: jest.SpyInstance | undefined
    try {
      if (scenario === "missing") await registry.deleteActiveTarget(accountId, target.id)
      if (scenario === "unreadable")
        read = jest
          .spyOn(RuntimeTargetRegistry.prototype, "getActiveTarget")
          .mockRejectedValue(new Error("Registry unavailable"))
      if (scenario === "wrong-pointer") {
        await registry.addTarget({
          accountId,
          id: "host-other",
          kind: "standalone",
          label: "Other",
        })
        await registry.activateTarget(accountId, "host-other")
      }
      expect(
        (await readCleanupOwnership(scenario === "wrong-database" ? "another-db" : database)).kind
      ).toBe("unknown")
    } finally {
      read?.mockRestore()
      await registry.deleteAccountTargets(accountId)
      registry.close()
    }
  }
)
