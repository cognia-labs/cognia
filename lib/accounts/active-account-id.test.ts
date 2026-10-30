/**
 * @jest-environment jsdom
 */
let mockDbName: string | (() => never) = "cognia-account-acct_1"
let mockSelectedDb: { name: string; isOpen: () => boolean } | null = null
let mockDbReads = 0

jest.mock("@/lib/db/schema", () => ({
  getDb: () => {
    mockDbReads += 1
    if (mockSelectedDb) return mockSelectedDb
    if (typeof mockDbName === "function") mockDbName()
    return { name: mockDbName }
  },
}))

import {
  DEFAULT_LOCAL_ACCOUNT_ID,
  getActiveAccountId,
  captureAccountScope,
} from "./active-account-id"

const originalEnv = process.env.COGNIA_LOCAL_ACCOUNT_ID

afterEach(() => {
  mockSelectedDb = null
  if (originalEnv === undefined) delete process.env.COGNIA_LOCAL_ACCOUNT_ID
  else process.env.COGNIA_LOCAL_ACCOUNT_ID = originalEnv
})

describe("captureAccountScope", () => {
  it("rejects switching to another profile or reopening the same profile", () => {
    mockSelectedDb = { name: "cognia-account-acct_alpha", isOpen: () => true }
    const assertCurrent = captureAccountScope("acct_alpha")
    expect(assertCurrent).not.toThrow()
    mockSelectedDb = { name: "cognia-account-acct_beta", isOpen: () => true }
    expect(assertCurrent).toThrow("profile changed")
    mockSelectedDb = { name: "cognia-account-acct_alpha", isOpen: () => true }
    expect(assertCurrent).toThrow("profile changed")
  })

  it("rejects a closed scope without resolving and reopening the legacy database", () => {
    let open = true
    mockSelectedDb = { name: "cognia-account-acct_alpha", isOpen: () => open }
    const assertCurrent = captureAccountScope("acct_alpha")
    open = false
    const before = mockDbReads
    expect(assertCurrent).toThrow("profile changed")
    expect(mockDbReads).toBe(before)
  })
})

describe("getActiveAccountId", () => {
  it("reads the account out of the active database name", () => {
    mockDbName = "cognia-account-acct_1"
    expect(getActiveAccountId()).toBe("acct_1")
  })

  it("does not include the runtime target suffix in the account boundary", () => {
    mockDbName = "cognia-account-acct_1-target-headless_primary"
    expect(getActiveAccountId()).toBe("acct_1")
  })

  it("drops the encryption suffix, so an encrypted account keeps its real id", () => {
    mockDbName = "cognia-account-acct_1-encrypted-v1"
    expect(getActiveAccountId()).toBe("acct_1")
  })

  it("drops both the target and the encryption suffix", () => {
    mockDbName = "cognia-account-acct_1-target-headless_primary-encrypted-v1"
    expect(getActiveAccountId()).toBe("acct_1")
  })

  it("falls back to the default for a pre-multi-account database name", () => {
    mockDbName = "cognia"
    delete process.env.COGNIA_LOCAL_ACCOUNT_ID
    expect(getActiveAccountId()).toBe(DEFAULT_LOCAL_ACCOUNT_ID)
  })

  it("honours an explicit headless override", () => {
    mockDbName = "cognia"
    process.env.COGNIA_LOCAL_ACCOUNT_ID = "ci_account"
    expect(getActiveAccountId()).toBe("ci_account")
  })

  it("stays total when there is no database at all", () => {
    // SSR / static-export prerender: `getDb()` throws, and a persistence key
    // derivation must not become an exception because of it.
    mockDbName = () => {
      throw new Error("no indexeddb")
    }
    delete process.env.COGNIA_LOCAL_ACCOUNT_ID
    expect(getActiveAccountId()).toBe(DEFAULT_LOCAL_ACCOUNT_ID)
  })
})
