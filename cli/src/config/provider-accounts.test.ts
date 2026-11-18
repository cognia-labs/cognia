import {
  chooseAccount,
  describeAccountChoice,
  namedAccounts,
  storedAccounts,
} from "./provider-accounts"

describe("storedAccounts", () => {
  it("lists the unnamed slot as default, then named accounts by name", () => {
    expect(
      storedAccounts({
        apiKey: "k",
        accounts: { zeta: { apiKey: "z" }, alpha: { authToken: "t" } },
      }).map((account) => account.name)
    ).toEqual(["default", "alpha", "zeta"])
    expect(storedAccounts(undefined)).toEqual([])
    expect(storedAccounts({ accounts: { only: { apiKey: "o" } } })).toEqual([
      { name: "only", apiKey: "o" },
    ])
  })
})

describe("namedAccounts", () => {
  it("lets later layers win, and binds providerAccount to the active provider", () => {
    const named = namedAccounts(
      [
        {
          source: "user-config",
          origin: "/u.json",
          layer: { providers: { openai: { account: "home" }, groq: { account: "g" } } },
        },
        {
          source: "project-config",
          origin: "/p.json",
          layer: { providers: { openai: { account: "work" } } },
        },
        { source: "flag", origin: "--provider-account", layer: { providerAccount: "ops" } },
      ],
      "groq"
    )
    expect(named.get("openai")).toEqual({
      name: "work",
      source: "project-config",
      origin: "/p.json",
    })
    expect(named.get("groq")).toEqual({ name: "ops", source: "flag", origin: "--provider-account" })
  })
})

describe("chooseAccount", () => {
  const entry = { apiKey: "d", accounts: { work: { apiKey: "w" } } }

  it("takes the named account, else default, else the only one", () => {
    expect(chooseAccount("openai", entry, { name: "work", source: "flag" })).toMatchObject({
      kind: "account",
      account: { name: "work", apiKey: "w" },
    })
    expect(chooseAccount("openai", entry, undefined)).toMatchObject({
      kind: "account",
      selection: { name: "default", source: "default" },
    })
    expect(
      chooseAccount("openai", { accounts: { solo: { apiKey: "s" } } }, undefined)
    ).toMatchObject({ kind: "account", selection: { name: "solo", source: "only" } })
  })

  it("chooses none of several named accounts, and none when nothing is stored", () => {
    expect(
      chooseAccount("openai", { accounts: { a: { apiKey: "1" }, b: { apiKey: "2" } } }, undefined)
    ).toEqual({ kind: "none", ambiguous: ["a", "b"] })
    expect(chooseAccount("openai", undefined, undefined)).toEqual({ kind: "none" })
  })

  it("refuses a named account that is not stored, saying how to add it", () => {
    expect(() =>
      chooseAccount("openai", entry, {
        name: "ops",
        source: "env",
        origin: "COGNIA_PROVIDER_ACCOUNT",
      })
    ).toThrow(
      'provider "openai" has no stored account "ops" (chosen by COGNIA_PROVIDER_ACCOUNT; stored: default, work). ' +
        "Save it with: cognia-agent auth login --provider openai --name ops --api-key <key>"
    )
    expect(() => chooseAccount("groq", undefined, { name: "x", source: "flag" })).toThrow(
      /none is stored/
    )
  })
})

describe("describeAccountChoice", () => {
  it("names what chose the account", () => {
    expect(
      describeAccountChoice({ name: "a", source: "user-config", origin: "/u/config.json" })
    ).toBe("chosen in /u/config.json")
    expect(describeAccountChoice({ name: "a", source: "only" })).toBe("the only account stored")
  })
})
