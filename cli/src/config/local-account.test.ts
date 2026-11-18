/**
 * @jest-environment node
 */
import path from "node:path"

import { parseArgv } from "../cli/args"
import {
  accountIdFromDirName,
  accountSignInDir,
  describeLocalAccountSource,
  HEADLESS_LOCAL_ACCOUNT_ID,
  invalidLocalAccountId,
  localAccountsRoot,
  resolveLocalAccount,
} from "./local-account"

const args = (...argv: string[]) => parseArgv(["serve", ...argv])

describe("resolveLocalAccount", () => {
  it("takes --account first, then COGNIA_LOCAL_ACCOUNT_ID, then the Host's default", () => {
    const env = { COGNIA_LOCAL_ACCOUNT_ID: "from-env" }
    expect(resolveLocalAccount(args("--account", "work"), env)).toEqual({
      ok: true,
      account: { id: "work", source: "flag" },
    })
    expect(resolveLocalAccount(args(), env)).toEqual({
      ok: true,
      account: { id: "from-env", source: "env" },
    })
    expect(resolveLocalAccount(args(), {})).toEqual({
      ok: true,
      account: { id: HEADLESS_LOCAL_ACCOUNT_ID, source: "default" },
    })
    expect(resolveLocalAccount(args(), { COGNIA_LOCAL_ACCOUNT_ID: "" })).toMatchObject({
      account: { source: "default" },
    })
  })

  it("refuses --account without a value rather than falling back", () => {
    expect(resolveLocalAccount(args("--account"), { COGNIA_LOCAL_ACCOUNT_ID: "x" })).toEqual({
      ok: false,
      error: "--account needs a value: the local account to act for",
    })
  })

  it("refuses an id that cannot name an account, saying where it came from", () => {
    expect(resolveLocalAccount(args("--account", " work"), {})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^--account: .*whitespace/),
    })
    expect(resolveLocalAccount(args(), { COGNIA_LOCAL_ACCOUNT_ID: "a\u0001" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^COGNIA_LOCAL_ACCOUNT_ID: .*control/),
    })
  })

  it("names every source", () => {
    expect(describeLocalAccountSource("flag")).toBe("--account")
    expect(describeLocalAccountSource("env")).toBe("COGNIA_LOCAL_ACCOUNT_ID")
    expect(describeLocalAccountSource("default")).toBe("default")
  })
})

describe("account sign-in directories", () => {
  const home = "/h"

  it("lives under <home>/accounts with the id encoded", () => {
    expect(localAccountsRoot(home)).toBe(path.join(home, "accounts"))
    expect(accountSignInDir(home, "local_acct_a")).toBe(path.join(home, "accounts", "local_acct_a"))
    expect(accountSignInDir(home, "a/b")).toBe(path.join(home, "accounts", "a%2Fb"))
  })

  it("never lets an id climb out of the accounts directory", () => {
    expect(accountSignInDir(home, "..")).toBe(path.join(home, "accounts", "%2E%2E"))
    expect(accountSignInDir(home, ".")).toBe(path.join(home, "accounts", "%2E"))
    expect(() => accountSignInDir(home, "")).toThrow(/empty/)
    expect(invalidLocalAccountId("x".repeat(129))).toMatch(/128/)
  })

  it("maps a directory name back to its id, and only names it wrote", () => {
    for (const id of ["local_acct_a", "a/b", "..", ".", "Ann's laptop"]) {
      expect(accountIdFromDirName(path.basename(accountSignInDir(home, id)))).toBe(id)
    }
    expect(accountIdFromDirName("%zz")).toBeNull()
    expect(accountIdFromDirName("a b")).toBeNull()
    expect(accountIdFromDirName("..")).toBeNull()
  })
})
