/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import type { LocalAccountRecord, PasswordVerifierRecord } from "@/lib/accounts/account-types"
import type { QuickUnlockEnrollment } from "@/lib/accounts/quick-unlock/types"
import type { EnrollArgs, VerifyArgs, QuickUnlockOutcome } from "@/lib/accounts/quick-unlock/client"

import type { ProfileCloudIdentityCleanup } from "@/lib/identity/forget-profile-identity"

import type { AccountStoreDependencies } from "@/stores/account/account-store"

let mockDesktopLocalEnabled = false
// Null follows `mockDesktopLocalEnabled`; the native mobile app sets it apart,
// because there a remembered profile works without the desktop workspace.
let mockDeviceUnlockSupported: boolean | null = null
const mockDesktopLocalPassword = jest.fn<Promise<string | null>, [boolean?]>()
const mockSaveDesktopRecovery = jest.fn<Promise<void>, [string]>()
const mockReadDesktopRecovery = jest.fn<Promise<string | null>, []>()
const mockClearDesktopRecovery = jest.fn<Promise<void>, []>()
const mockClearDesktopLocalPassword = jest.fn<Promise<void>, []>()
const mockReadDeviceUnlockSecret = jest.fn<Promise<string | null>, [string]>()
const mockSaveDeviceUnlockSecret = jest.fn<Promise<void>, [string, string]>()
const mockClearDeviceUnlockSecret = jest.fn<Promise<void>, [string]>()
jest.mock("@/lib/accounts/desktop-local-account", () => ({
  DESKTOP_LOCAL_ACCOUNT_ID: "acct_desktop_local_workspace",
  deviceLocalAccountId: () => (mockIsCapacitor ? "local_acct_a" : "acct_desktop_local_workspace"),
  isDeviceLocalAccountEnabled: () => mockDesktopLocalEnabled,
  isDeviceUnlockSupported: () => mockDeviceUnlockSupported ?? mockDesktopLocalEnabled,
  isDeviceManagedAccount: (record: LocalAccountRecord | null | undefined) =>
    (record?.id === "acct_desktop_local_workspace" || record?.id === "local_acct_a") &&
    record.protection === "device",
  isRememberedOnDevice: (record: LocalAccountRecord | null | undefined) =>
    !!record && record.protection !== "device" && record.rememberOnDevice === true,
  readDeviceUnlockSecret: (id: string) => mockReadDeviceUnlockSecret(id),
  saveDeviceUnlockSecret: (id: string, secret: string) => mockSaveDeviceUnlockSecret(id, secret),
  clearDeviceUnlockSecret: (id: string) => mockClearDeviceUnlockSecret(id),
  desktopLocalAccountPassword: (...args: [boolean?]) => mockDesktopLocalPassword(...args),
  clearDesktopLocalAccountPassword: () => mockClearDesktopLocalPassword(),
  saveDesktopLocalAccountRecoveryKey: (key: string) => mockSaveDesktopRecovery(key),
  readDesktopLocalAccountRecoveryKey: () => mockReadDesktopRecovery(),
  clearDesktopLocalAccountRecoveryKey: () => mockClearDesktopRecovery(),
}))

const mockForgetProfileCloudIdentity = jest.fn()
jest.mock("@/lib/identity/forget-profile-identity", () => ({
  forgetProfileCloudIdentity: (...args: unknown[]) => mockForgetProfileCloudIdentity(...args),
}))

const mockBumpPerformanceSecurityGeneration = jest.fn()
jest.mock("@/lib/perf/security-generation", () => ({
  bumpPerformanceSecurityGeneration: (...args: unknown[]) =>
    mockBumpPerformanceSecurityGeneration(...args),
}))

const mockListAccounts = jest.fn<Promise<LocalAccountRecord[]>, []>()
const mockGetState = jest.fn<Promise<{ activeAccountId: string | null }>, []>()
const mockCreateRegistryAccount = jest.fn<Promise<LocalAccountRecord>, [unknown]>()
const mockRenameRegistryAccount = jest.fn<Promise<LocalAccountRecord>, [string, string]>()
const mockUpdatePasswordVerifier = jest.fn<
  Promise<LocalAccountRecord>,
  [string, PasswordVerifierRecord]
>()
const mockSetActiveAccountId = jest.fn<Promise<void>, [string]>()
const mockDeleteRegistryAccount = jest.fn<Promise<void>, [string, unknown?]>()
const mockUpdateAvatarRegistry = jest.fn<Promise<LocalAccountRecord>, [string, string | null]>()
const mockUpdateRememberOnDevice = jest.fn<Promise<LocalAccountRecord>, [string, boolean]>()
const mockUpdateQuickUnlock = jest.fn()
const mockEnrollQuickUnlock = jest.fn<Promise<QuickUnlockEnrollment>, [EnrollArgs]>()
const mockVerifyQuickUnlock = jest.fn<Promise<QuickUnlockOutcome>, [VerifyArgs]>()
const mockRemoveQuickUnlock = jest.fn<Promise<void>, [string, string, Record<string, unknown>?]>(
  async () => {}
)
const mockRemoveNativeBiometricSecret = jest.fn<Promise<void>, [string, string]>(async () => {})
jest.mock("@/lib/accounts/quick-unlock/client", () => ({
  enrollQuickUnlock: (args: EnrollArgs) => mockEnrollQuickUnlock(args),
  removeQuickUnlock: (...args: [string, string, Record<string, unknown>?]) =>
    mockRemoveQuickUnlock(...args),
  clearQuickUnlockDeviceMaterial: jest.fn(async () => {}),
  verifyQuickUnlock: (args: VerifyArgs) => mockVerifyQuickUnlock(args),
}))
jest.mock("@/lib/accounts/quick-unlock/native-biometric", () => ({
  removeNativeBiometricSecret: (...args: [string, string]) =>
    mockRemoveNativeBiometricSecret(...args),
}))

jest.mock("@/lib/accounts/account-db", () => ({
  LocalAccountRegistry: jest.fn().mockImplementation(() => ({
    readBootSnapshot: () => Promise.all([mockListAccounts(), mockGetState()]),
    listAccounts: mockListAccounts,
    getState: mockGetState,
    createAccount: mockCreateRegistryAccount,
    renameAccount: mockRenameRegistryAccount,
    updatePasswordVerifier: mockUpdatePasswordVerifier,
    updateAvatar: mockUpdateAvatarRegistry,
    updateRememberOnDevice: mockUpdateRememberOnDevice,
    updateQuickUnlock: mockUpdateQuickUnlock,
    setActiveAccountId: mockSetActiveAccountId,
    deleteAccount: mockDeleteRegistryAccount,
  })),
  accountDatabaseName: (accountId: string) => `cognia-account-${accountId}`,
  encryptedAccountDatabaseName: (accountId: string) => `cognia-account-${accountId}-encrypted-v1`,
  generateAccountId: () => "acct_generated",
}))

const mockCreatePasswordVerifier = jest.fn<Promise<PasswordVerifierRecord>, [string]>()
const mockVerifyPassword = jest.fn<
  Promise<boolean>,
  [string, PasswordVerifierRecord, string | undefined]
>()
const mockUnbindLocalAccount = jest.fn<Promise<void>, []>()
const mockRotateNativePassword = jest.fn<
  Promise<PasswordVerifierRecord>,
  [string, string, PasswordVerifierRecord, string, PasswordVerifierRecord?]
>()

jest.mock("@/lib/accounts/password-client", () => ({
  createPasswordVerifier: mockCreatePasswordVerifier,
  verifyPassword: mockVerifyPassword,
  unbindLocalAccount: mockUnbindLocalAccount,
  rotateNativePassword: mockRotateNativePassword,
}))

let mockIsTauri = true
let mockIsCapacitor = false
jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => mockIsTauri,
  isCapacitor: () => mockIsCapacitor,
}))

const mockProvisionBrowserVault = jest.fn<Promise<string>, [string, string]>()
const mockUnlockBrowserVault = jest.fn<Promise<void>, [string, string]>()
const mockVerifyBrowserVaultPassword = jest.fn<Promise<boolean>, [string, string]>()
const mockChangeBrowserVaultPassword = jest.fn<Promise<void>, [string, string, string]>()
const mockResetVaultWithRecoveryKey = jest.fn<Promise<void>, [string, string, string]>()
const mockDeleteBrowserVault = jest.fn<Promise<void>, [string]>()
const mockLockBrowserVault = jest.fn<void, []>()
const mockBrowserVaultExists = jest.fn<Promise<boolean>, [string]>()
let mockActiveBrowserVaultAccountId: string | null = null
jest.mock("@/lib/runtime/browser-vault", () => ({
  provisionBrowserVault: (...args: [string, string]) => mockProvisionBrowserVault(...args),
  unlockBrowserVault: (...args: [string, string]) => mockUnlockBrowserVault(...args),
  verifyBrowserVaultPassword: (...args: [string, string]) =>
    mockVerifyBrowserVaultPassword(...args),
  changeBrowserVaultPassword: (...args: [string, string, string]) =>
    mockChangeBrowserVaultPassword(...args),
  deleteBrowserVault: (...args: [string]) => mockDeleteBrowserVault(...args),
  lockBrowserVault: () => mockLockBrowserVault(),
  browserVaultExists: (...args: [string]) => mockBrowserVaultExists(...args),
  getActiveBrowserVault: () =>
    mockActiveBrowserVaultAccountId
      ? {
          localAccountId: mockActiveBrowserVaultAccountId,
          createContentCipher: (databaseName: string) => ({ databaseName, lock: jest.fn() }),
        }
      : null,
  resetBrowserVaultPasswordWithRecoveryKey: (...args: [string, string, string]) =>
    mockResetVaultWithRecoveryKey(...args),
}))

const mockSetActiveRuntimeTargetContext = jest.fn<void, [string, string]>()
const mockClearActiveRuntimeTargetContext = jest.fn<void, []>()
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  setActiveRuntimeTargetContext: (...args: [string, string]) =>
    mockSetActiveRuntimeTargetContext(...args),
  clearActiveRuntimeTargetContext: () => mockClearActiveRuntimeTargetContext(),
}))

const mockActivateAccountDatabase = jest.fn<void, [string]>()
const mockClearAccountDatabaseSelection = jest.fn<void, []>()

jest.mock("@/lib/db/schema", () => ({
  activateAccountDatabase: mockActivateAccountDatabase,
  clearAccountDatabaseSelection: mockClearAccountDatabaseSelection,
}))

const mockEnsureActiveDatabaseReady = jest.fn(async () => ({
  databaseName: "test",
  restoredPluginTables: [],
}))
jest.mock("@/lib/db/boot", () => ({
  ensureActiveDatabaseReady: mockEnsureActiveDatabaseReady,
}))

const mockDropAccountDatabase = jest.fn<Promise<void>, [string]>()
const mockForgetCloudIdentity = jest.fn<
  Promise<ProfileCloudIdentityCleanup>,
  [string, { hostBound: boolean }]
>()
const mockPurgeAccountLocalState = jest.fn<Promise<void>, [string]>()
const mockPurgeAccountFiles = jest.fn<Promise<void>, [string]>()
const mockActivateAccountLocalState = jest.fn<Promise<void>, [string]>()
const mockClearAccountLocalState = jest.fn<void, []>()
const mockReadActiveRuntimeTarget = jest.fn().mockResolvedValue(null)
const mockPrepareRuntimeTarget = jest.fn()
const mockPrepareDatabase = jest.fn<Promise<unknown>, []>()
const mockRemoveRuntimeTargets = jest.fn<Promise<void>, [string]>()
const mockClearSubscriptionRuntime = jest.fn<Promise<void>, [string]>()
const mockStopRuntimeSubscriptions = jest.fn<Promise<void>, []>()
const mockTeardownPluginRuntime = jest.fn<Promise<void>, [string]>()
const mockActivateContentCipher = jest.fn<void, [string, string]>()
const mockMigrateLocalContentDatabase = jest.fn<Promise<void>, [string]>()

let createAccountStore: typeof import("@/stores/account/account-store").createAccountStore

beforeAll(async () => {
  const mod = await import("@/stores/account/account-store")
  createAccountStore = mod.createAccountStore
})

const verifier = (tag: string): PasswordVerifierRecord => ({
  algorithm: "argon2id-v1",
  salt: `salt-${tag}`,
  hash: `hash-${tag}`,
  params: { memoryCost: 1 },
})

const account = (
  id: string,
  displayName: string,
  passwordVerifier: PasswordVerifierRecord = verifier(id)
): LocalAccountRecord => ({
  id,
  displayName,
  passwordVerifier,
  createdAt: 100,
  updatedAt: 100,
})

function cleanCloudIdentity(localAccountId: string): ProfileCloudIdentityCleanup {
  return {
    localAccountId,
    steps: {
      session: { status: "done" },
      "plugin-auth": { status: "done" },
      binding: { status: "done" },
      "collab-connection": { status: "done" },
      "host-person": { status: "skipped", reason: "not-bound-on-host" },
    },
    failures: [],
    tokensMayRemainLive: false,
  }
}

function makeStore() {
  const dependencies: Partial<AccountStoreDependencies> = {
    dropAccountDatabase: mockDropAccountDatabase,
    purgeAccountLocalState: mockPurgeAccountLocalState,
    purgeAccountFiles: mockPurgeAccountFiles,
    activateAccountLocalState: mockActivateAccountLocalState,
    clearAccountLocalState: mockClearAccountLocalState,
    prepareRuntimeTarget: mockPrepareRuntimeTarget,
    readActiveRuntimeTarget: mockReadActiveRuntimeTarget,
    prepareDatabase: mockPrepareDatabase,
    removeRuntimeTargets: mockRemoveRuntimeTargets,
    clearSubscriptionRuntime: mockClearSubscriptionRuntime,
    stopRuntimeSubscriptions: mockStopRuntimeSubscriptions,
    teardownPluginRuntime: mockTeardownPluginRuntime,
    activateContentCipher: mockActivateContentCipher,
    migrateLocalContentDatabase: mockMigrateLocalContentDatabase,
    forgetCloudIdentity: mockForgetCloudIdentity,
  }
  return createAccountStore(dependencies)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockEnrollQuickUnlock.mockImplementation(async (args) => {
    const enrollment = {
      method: args.method,
      verifier: { storage: "browser-vault", createdAt: 2 },
      createdAt: 2,
      failedAttempts: 0,
    }
    await args.persist?.(enrollment)
    return enrollment
  })
  mockDesktopLocalEnabled = false
  mockDeviceUnlockSupported = null
  mockSaveDesktopRecovery.mockResolvedValue()
  mockReadDesktopRecovery.mockResolvedValue("preserved-recovery-key")
  mockClearDesktopRecovery.mockResolvedValue()
  mockDesktopLocalPassword.mockResolvedValue("device-random-secret")
  mockClearDesktopLocalPassword.mockResolvedValue()
  window.localStorage.clear()
  window.sessionStorage.clear()
  mockIsTauri = true
  mockIsCapacitor = false
  mockReadActiveRuntimeTarget.mockReset().mockResolvedValue(null)
  mockProvisionBrowserVault.mockResolvedValue("recovery-key")
  mockProvisionBrowserVault.mockImplementation(async (accountId) => {
    mockActiveBrowserVaultAccountId = accountId
    return "recovery-key"
  })
  mockUnlockBrowserVault.mockImplementation(async (accountId) => {
    mockActiveBrowserVaultAccountId = accountId
  })
  mockActiveBrowserVaultAccountId = null
  mockBrowserVaultExists.mockResolvedValue(true)
  mockVerifyBrowserVaultPassword.mockResolvedValue(true)
  mockChangeBrowserVaultPassword.mockResolvedValue()
  mockDeleteBrowserVault.mockResolvedValue()
  mockTeardownPluginRuntime.mockResolvedValue()
  mockMigrateLocalContentDatabase.mockResolvedValue()
  mockForgetCloudIdentity.mockImplementation(async (localAccountId) =>
    cleanCloudIdentity(localAccountId)
  )
  mockForgetProfileCloudIdentity.mockImplementation(async (localAccountId: string) =>
    cleanCloudIdentity(localAccountId)
  )
  mockListAccounts.mockResolvedValue([])
  mockGetState.mockResolvedValue({ activeAccountId: null })
  mockCreatePasswordVerifier.mockImplementation(async (password) => verifier(password))
  mockVerifyPassword.mockResolvedValue(true)
  mockUnbindLocalAccount.mockResolvedValue()
  mockRotateNativePassword.mockImplementation(
    async (_accountId, _currentPassword, _currentVerifier, newPassword, targetVerifier) =>
      targetVerifier ?? verifier(newPassword)
  )
  mockCreateRegistryAccount.mockImplementation(async (input) => {
    const value = input as {
      id?: string
      displayName: string
      passwordVerifier: PasswordVerifierRecord
      activate?: boolean
    }
    return account(value.id ?? "acct_created", value.displayName, value.passwordVerifier)
  })
  mockRenameRegistryAccount.mockImplementation(async (id, displayName) =>
    account(id, displayName, verifier(id))
  )
  mockUpdatePasswordVerifier.mockImplementation(async (id, passwordVerifier) =>
    account(id, id, passwordVerifier)
  )
  mockUpdateAvatarRegistry.mockImplementation(async (id, avatarDataUrl) => ({
    ...account(id, id),
    avatarDataUrl: avatarDataUrl ?? undefined,
  }))
  mockUpdateRememberOnDevice.mockImplementation(async (id, enabled) => ({
    ...account(id, id),
    ...(enabled ? { rememberOnDevice: true } : {}),
  }))
  mockReadDeviceUnlockSecret.mockResolvedValue(null)
  mockSaveDeviceUnlockSecret.mockResolvedValue()
  mockClearDeviceUnlockSecret.mockResolvedValue()
  mockDropAccountDatabase.mockResolvedValue()
  mockPurgeAccountLocalState.mockResolvedValue()
  mockPurgeAccountFiles.mockReset().mockResolvedValue()
  mockActivateAccountLocalState.mockResolvedValue()
  mockPrepareRuntimeTarget.mockResolvedValue({
    accountId: "acct_browser",
    id: "web-standalone",
    kind: "standalone",
    label: "This browser",
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
  })
  mockPrepareDatabase.mockResolvedValue({ databaseName: "test", restoredPluginTables: [] })
  mockRemoveRuntimeTargets.mockResolvedValue()
  mockClearSubscriptionRuntime.mockResolvedValue()
  mockStopRuntimeSubscriptions.mockResolvedValue()
  mockResetVaultWithRecoveryKey.mockResolvedValue()
})

// Production store; mocked infrastructure and crypto as in its co-located suite.
// This probe measures supported recovery routing, not cryptographic decryptability.
describe("native recovery audit", () => {
  it.each([
    ["Tauri", true, false],
    ["Capacitor", false, true],
  ])(
    "%s shows a newly provisioned key but rejects same-shell redemption",
    async (_name, tauri, capacitor) => {
      mockIsTauri = tauri
      mockIsCapacitor = capacitor
      const store = makeStore()
      const created = await store.getState().createAccount({
        id: "acct_native_recovery_audit",
        displayName: "Audit fixture",
        password: "audit-original-password",
      })
      expect(mockProvisionBrowserVault).toHaveBeenCalledWith(created.id, "audit-original-password")
      expect(store.getState().pendingRecoveryKey).toBe("recovery-key")
      store.getState().acknowledgeRecoveryKey()
      expect(store.getState().pendingRecoveryKey).toBeNull()
      await store.getState().lock()
      expect(store.getState().locked).toBe(true)
      await expect(
        store
          .getState()
          .unlockAccountWithRecoveryKey(created.id, "recovery-key", "audit-replacement-password")
      ).rejects.toMatchObject({ code: "vault-not-provisioned" })
      expect(mockResetVaultWithRecoveryKey).not.toHaveBeenCalled()
      expect(store.getState().locked).toBe(true)
      expect(store.getState().unlockedAccountId).toBeNull()
      expect(store.getState().error).toBe("Desktop recovery requires the native recovery flow.")
    }
  )

  it("Tauri promotion shows its preserved key but rejects it after locking", async () => {
    const id = "acct_desktop_local_workspace"
    const native = { ...account(id, "Local"), protection: "device" as const }
    const store = makeStore()
    store.setState({
      accounts: [native],
      activeAccountId: id,
      unlockedAccountId: id,
      locked: false,
    })
    mockUpdatePasswordVerifier.mockResolvedValue({ ...native, protection: "password" })
    await store.getState().changePassword(id, "", "audit-new-password")
    expect(mockRotateNativePassword).toHaveBeenCalled()
    expect(store.getState().accounts[0]?.protection).toBe("password")
    expect(store.getState().pendingRecoveryKey).toBe("preserved-recovery-key")
    await store.getState().lock()
    await expect(
      store
        .getState()
        .unlockAccountWithRecoveryKey(id, "preserved-recovery-key", "audit-replacement-password")
    ).rejects.toMatchObject({ code: "vault-not-provisioned" })
    expect(mockResetVaultWithRecoveryKey).not.toHaveBeenCalled()
    expect(store.getState().locked).toBe(true)
  })
})
