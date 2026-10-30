/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { act, cleanup, renderHook } from "@testing-library/react"
import { useStore } from "zustand"

import { LocalAccountRegistry } from "@/lib/accounts/account-db"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { interruptSession } from "@/lib/claude/ipc"
import {
  registerRuntimeTargetCleanup,
  stopRuntimeTargetSubscriptions,
} from "@/lib/runtime/runtime-target-lifecycle"
import { lockBrowserVault } from "@/lib/runtime/browser-vault"
import {
  createAccountStore,
  type AccountStore,
  type AccountStoreDependencies,
} from "@/stores/account/account-store"

import { useAutoLockOnIdle } from "./use-auto-lock-on-idle"

// Keep the hook and account transition orchestration real. Only the database,
// vault, native IPC and UI-dependent runtimes are isolated at their boundaries.
let mockStore: AccountStore
jest.mock("@/stores/account/account-store", () => ({
  ...jest.requireActual("@/stores/account/account-store"),
  useAccountStore: Object.assign(
    (selector: Parameters<typeof useStore>[1]) => useStore(mockStore, selector),
    { getState: () => mockStore.getState() }
  ),
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => true,
  isCapacitor: () => false,
}))
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => null,
  isSecondaryOverlayRole: () => false,
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { accountAutoLockMinutes: 5 } }),
}))
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => ({ sessions: { turn_alpha: { status: "streaming" } } }) },
}))
jest.mock("@/lib/claude/ipc", () => ({ interruptSession: jest.fn() }))
jest.mock("@/lib/accounts/password-client", () => ({
  verifyPassword: jest.fn(async () => true),
  unbindLocalAccount: jest.fn(async () => {}),
}))
jest.mock("@/lib/runtime/browser-vault", () => ({
  browserVaultExists: jest.fn(async () => true),
  unlockBrowserVault: jest.fn(async () => {}),
  lockBrowserVault: jest.fn(),
}))
jest.mock("@/lib/db/schema", () => ({
  activateAccountDatabase: jest.fn(),
  clearAccountDatabaseSelection: jest.fn(),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  setActiveRuntimeTargetContext: jest.fn(),
  clearActiveRuntimeTargetContext: jest.fn(),
}))
jest.mock("@/lib/perf/security-generation", () => ({
  bumpPerformanceSecurityGeneration: jest.fn(),
}))

const interruptMock = jest.mocked(interruptSession)
const revokeVaultMock = jest.mocked(lockBrowserVault)
const dropDatabase = jest.fn<Promise<void>, [string]>()
const releaseSubscriptions = jest.fn<Promise<void>, []>()
const ORIGINAL_ACCOUNT_GATE = process.env.NEXT_PUBLIC_ACCOUNT_GATE
const LOCK_WINDOW_MS = 5 * 60_000

function profile(id: string): LocalAccountRecord {
  return {
    id,
    displayName: id,
    passwordVerifier: { algorithm: "fixture", salt: "fixture", hash: "fixture", params: {} },
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  jest.setSystemTime(0)
  process.env.NEXT_PUBLIC_ACCOUNT_GATE = "1"
  const registry = new LocalAccountRegistry()
  registry.setActiveAccountId = jest.fn(async () => {})
  const dependencies: Partial<AccountStoreDependencies> = {
    registry,
    dropAccountDatabase: dropDatabase,
    stopRuntimeSubscriptions: stopRuntimeTargetSubscriptions,
    teardownPluginRuntime: async () => {},
    clearSubscriptionRuntime: async () => {},
    clearAccountLocalState: () => {},
    activateAccountLocalState: async () => {},
    activateContentCipher: () => {},
    migrateLocalContentDatabase: async () => {},
    prepareDatabase: async () => {},
  }
  mockStore = createAccountStore(dependencies)
  mockStore.setState({
    accounts: [profile("acct_alpha"), profile("acct_beta")],
    activeAccountId: "acct_alpha",
    unlockedAccountId: "acct_alpha",
    locked: false,
    loaded: true,
  })
  releaseSubscriptions.mockResolvedValue()
  registerRuntimeTargetCleanup(releaseSubscriptions)
})

afterEach(async () => {
  cleanup()
  await stopRuntimeTargetSubscriptions()
  jest.useRealTimers()
  if (ORIGINAL_ACCOUNT_GATE === undefined) delete process.env.NEXT_PUBLIC_ACCOUNT_GATE
  else process.env.NEXT_PUBLIC_ACCOUNT_GATE = ORIGINAL_ACCOUNT_GATE
})

it("revokes the actual store's vault and subscriptions within a bounded interrupt wait", async () => {
  interruptMock.mockReturnValue(new Promise(() => {}))
  renderHook(() => useAutoLockOnIdle())

  await act(async () => jest.advanceTimersByTime(LOCK_WINDOW_MS * 2 + 1_000))

  expect(mockStore.getState()).toMatchObject({ locked: true, unlockedAccountId: null })
  expect(revokeVaultMock).toHaveBeenCalledTimes(1)
  expect(releaseSubscriptions).toHaveBeenCalledTimes(1)
  expect(dropDatabase).not.toHaveBeenCalled()
})

it("retains the newly switched profile when the old interrupt finishes", async () => {
  let finishInterrupt!: () => void
  interruptMock.mockReturnValue(new Promise((resolve) => (finishInterrupt = resolve)))
  const owner = renderHook(() => useAutoLockOnIdle())
  await act(async () => jest.advanceTimersByTime(LOCK_WINDOW_MS * 2))
  owner.unmount()

  await act(async () => {
    await mockStore.getState().switchAccount("acct_beta", "fixture-password")
  })
  expect(mockStore.getState()).toMatchObject({ locked: false, unlockedAccountId: "acct_beta" })
  const revision = mockStore.getState().accountRevision
  await act(async () => finishInterrupt())
  await act(async () => jest.advanceTimersByTime(1_000))

  expect(mockStore.getState()).toMatchObject({
    locked: false,
    unlockedAccountId: "acct_beta",
    accountRevision: revision,
  })
  expect(dropDatabase).not.toHaveBeenCalled()
})

it("fences the old interrupt while the hook stays mounted through an actual profile switch", async () => {
  let finishInterrupt!: () => void
  interruptMock.mockReturnValue(new Promise((resolve) => (finishInterrupt = resolve)))
  renderHook(() => useAutoLockOnIdle())
  await act(async () => jest.advanceTimersByTime(LOCK_WINDOW_MS * 2))

  await act(async () => {
    await mockStore.getState().switchAccount("acct_beta", "fixture-password")
  })
  expect(mockStore.getState()).toMatchObject({ locked: false, unlockedAccountId: "acct_beta" })
  const revision = mockStore.getState().accountRevision

  await act(async () => finishInterrupt())
  await act(async () => jest.advanceTimersByTime(1_000))

  expect(mockStore.getState()).toMatchObject({
    locked: false,
    unlockedAccountId: "acct_beta",
    accountRevision: revision,
  })
  // Only the intentional switch locked A; the old idle callback never locks B.
  expect(revokeVaultMock).toHaveBeenCalledTimes(1)
  expect(dropDatabase).not.toHaveBeenCalled()
})

it("does not relock a fresh unlock of the same profile after the interrupt deadline", async () => {
  let finishInterrupt!: () => void
  interruptMock.mockReturnValue(new Promise((resolve) => (finishInterrupt = resolve)))
  renderHook(() => useAutoLockOnIdle())
  await act(async () => jest.advanceTimersByTime(LOCK_WINDOW_MS * 2 + 1_000))
  expect(mockStore.getState().locked).toBe(true)

  await act(async () => {
    await mockStore.getState().unlockAccount("acct_alpha", "fixture-password")
  })
  const revision = mockStore.getState().accountRevision
  await act(async () => finishInterrupt())

  expect(mockStore.getState()).toMatchObject({
    locked: false,
    unlockedAccountId: "acct_alpha",
    accountRevision: revision,
  })
  expect(revokeVaultMock).toHaveBeenCalledTimes(1)
})
