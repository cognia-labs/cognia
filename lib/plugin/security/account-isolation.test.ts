import { teardownPluginAccountRuntime } from "./account-isolation"
import {
  clearPermissionRequests,
  requestPluginPermission,
  subscribePermissionRequests,
} from "./permission-requests"

it("B02: cancels pending permission prompts before unloading runtimes", async () => {
  clearPermissionRequests()
  const settled: boolean[] = []
  const pending = requestPluginPermission({
    pluginId: "demo",
    permission: "filesystem:read",
    kind: "api",
  }).then((value) => settled.push(value))
  let hasPrompt = false
  const unsubscribe = subscribePermissionRequests((state) => {
    hasPrompt = state.current !== null
  })
  try {
    await teardownPluginAccountRuntime("acct_a", {
      block: jest.fn(),
      rejectPendingConsent: jest.fn(),
      runtimePluginIds: () => ["demo"],
      unload: async () => {
        expect(hasPrompt).toBe(false)
      },
      clearConsent: jest.fn(),
      clearPermissionGuard: jest.fn(),
      clearApiPermissions: jest.fn(),
      disposeManager: jest.fn(),
      clearAccount: jest.fn(),
    })
    expect(settled).toEqual([false])
    await pending
  } finally {
    unsubscribe()
    clearPermissionRequests()
  }
})

it("blocks first, unloads all runtimes, and clears every permission cache", async () => {
  const calls: string[] = []
  await teardownPluginAccountRuntime("acct_a", {
    block: () => calls.push("block"),
    rejectPendingConsent: () => calls.push("reject"),
    runtimePluginIds: () => ["one", "two"],
    unload: async (pluginId) => {
      calls.push(`unload:${pluginId}`)
    },
    clearConsent: () => calls.push("consent"),
    clearPermissionGuard: () => calls.push("guard"),
    clearApiPermissions: () => calls.push("api"),
    disposeManager: () => calls.push("dispose"),
    clearAccount: () => calls.push("clear-account"),
  })

  expect(calls).toEqual([
    "block",
    "reject",
    "unload:one",
    "unload:two",
    "consent",
    "guard",
    "api",
    "dispose",
    "clear-account",
  ])
})

it("clears authority but rejects the switch when any runtime survives", async () => {
  const cleared: string[] = []
  await expect(
    teardownPluginAccountRuntime("acct_a", {
      block: jest.fn(),
      rejectPendingConsent: jest.fn(),
      runtimePluginIds: () => ["broken"],
      unload: async () => {
        throw new Error("still running")
      },
      clearConsent: () => cleared.push("consent"),
      clearPermissionGuard: () => cleared.push("guard"),
      clearApiPermissions: () => cleared.push("api"),
      disposeManager: () => cleared.push("dispose"),
      clearAccount: () => cleared.push("account"),
    })
  ).rejects.toThrow("still running")
  expect(cleared).toEqual(["consent", "guard", "api", "dispose", "account"])
})

it("clears account authority even when the manager cannot yet be disposed", async () => {
  const clearAccount = jest.fn()
  await expect(
    teardownPluginAccountRuntime("acct_a", {
      block: jest.fn(),
      rejectPendingConsent: jest.fn(),
      runtimePluginIds: () => [],
      clearConsent: jest.fn(),
      clearPermissionGuard: jest.fn(),
      clearApiPermissions: jest.fn(),
      disposeManager: () => {
        throw new Error("manager is still initializing")
      },
      clearAccount,
    })
  ).rejects.toThrow("manager is still initializing")
  expect(clearAccount).toHaveBeenCalledTimes(1)
})
