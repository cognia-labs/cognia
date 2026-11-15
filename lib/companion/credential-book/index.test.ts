/**
 * @jest-environment jsdom
 */

import { createCredentialBook } from "./book"
import {
  __resetCredentialBookForTests,
  activeAccountNamespace,
  companionCredentialBook,
} from "./index"
import {
  emptyHostBook,
  type HostBookEnvelope,
  type HostCredentialStore,
  type HostRecordStore,
} from "./stores"
import type { CompanionCredentialBook, CompanionHostCredential, CompanionHostKey } from "./types"

jest.mock("@/lib/platform/detect", () => ({ isCapacitor: jest.fn(() => false) }))

const platform = jest.requireMock("@/lib/platform/detect") as { isCapacitor: jest.Mock }

jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: jest.fn(() => null),
}))
jest.mock("@/lib/runtime/browser-vault", () => ({
  getActiveBrowserVault: jest.fn(() => null),
}))

const runtimeContext = jest.requireMock("@/lib/runtime/runtime-target-context") as {
  getActiveRuntimeTargetContext: jest.Mock
}
const browserVault = jest.requireMock("@/lib/runtime/browser-vault") as {
  getActiveBrowserVault: jest.Mock
}

function memoryRecords(): HostRecordStore {
  let book: HostBookEnvelope = emptyHostBook()
  return {
    async read() {
      return JSON.parse(JSON.stringify(book)) as HostBookEnvelope
    },
    async write(next) {
      book = JSON.parse(JSON.stringify(next)) as HostBookEnvelope
    },
  }
}

function memoryCredentials(): HostCredentialStore {
  const entries = new Map<string, CompanionHostCredential>()
  const id = (key: CompanionHostKey) => `${key.accountNamespace}/${key.hostId}`
  return {
    async load(key) {
      return entries.get(id(key)) ?? null
    },
    async save(key, credential) {
      entries.set(id(key), credential)
    },
    async remove(key) {
      entries.delete(id(key))
    },
  }
}

function freshBook(): CompanionCredentialBook {
  return createCredentialBook({ records: memoryRecords(), credentials: memoryCredentials() })
}

beforeEach(() => {
  platform.isCapacitor.mockReturnValue(false)
  runtimeContext.getActiveRuntimeTargetContext.mockReturnValue(null)
  browserVault.getActiveBrowserVault.mockReturnValue(null)
  __resetCredentialBookForTests(null)
})

describe("activeAccountNamespace", () => {
  it("prefers the runtime target context", () => {
    runtimeContext.getActiveRuntimeTargetContext.mockReturnValue({
      accountId: "acct_target",
      targetId: "t1",
    })
    browserVault.getActiveBrowserVault.mockReturnValue({ localAccountId: "acct_vault" })
    expect(activeAccountNamespace()).toBe("acct_target")
  })

  it("falls back to the unlocked Vault", () => {
    browserVault.getActiveBrowserVault.mockReturnValue({ localAccountId: "acct_vault" })
    expect(activeAccountNamespace()).toBe("acct_vault")
  })

  it("reports null when nothing is active", () => {
    expect(activeAccountNamespace()).toBeNull()
  })
})

describe("companionCredentialBook", () => {
  it("memoises one book per process", () => {
    expect(companionCredentialBook()).toBe(companionCredentialBook())
  })

  it("can be replaced for tests", () => {
    const injected = freshBook()
    __resetCredentialBookForTests(injected)
    expect(companionCredentialBook()).toBe(injected)
  })
})
