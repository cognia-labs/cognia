/**
 * @jest-environment node
 */
import path from "node:path"

import {
  setCredential,
  setSearchCredential,
  deleteCredential,
  deleteSearchCredential,
  listCredentialProviders,
  listSearchCredentialProviders,
  listStoredAccounts,
  CREDENTIALS_MODE,
  type CredentialsFs,
} from "./credentials"
import { credentialsPath } from "./load"

const HOME = "/home/u/.cognia"

/** In-memory CredentialsFs that records the last write mode + mkdirp calls. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const writes: Array<{ path: string; mode: number }> = []
  const dirs: string[] = []
  const fsx: CredentialsFs = {
    read: (p) => (files.has(p) ? files.get(p)! : null),
    write: (p, content, mode) => {
      files.set(p, content)
      writes.push({ path: p, mode })
    },
    mkdirp: (dir) => {
      dirs.push(dir)
    },
    dirname: (p) => path.dirname(p),
  }
  return { fsx, files, writes, dirs }
}

describe("setCredential", () => {
  it("writes a new credentials.json with 0600 perms", () => {
    const m = memFs()
    const target = setCredential(HOME, "anthropic", "sk-1", m.fsx)
    expect(target).toBe(credentialsPath(HOME))
    expect(m.writes[0].mode).toBe(CREDENTIALS_MODE)
    expect(m.dirs[0]).toBe(path.dirname(credentialsPath(HOME)))
    const parsed = JSON.parse(m.files.get(target)!)
    expect(parsed.providers.anthropic.apiKey).toBe("sk-1")
  })

  it("preserves other providers when adding a key", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { openai: { apiKey: "sk-o" } } }),
    })
    setCredential(HOME, "anthropic", "sk-a", m.fsx)
    const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.openai.apiKey).toBe("sk-o")
    expect(parsed.providers.anthropic.apiKey).toBe("sk-a")
  })

  it("preserves search-provider credentials when changing a model provider", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({
        searchProviders: { tavily: { apiKey: "tvly" } },
      }),
    })
    setCredential(HOME, "anthropic", "sk-a", m.fsx)
    const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.searchProviders.tavily.apiKey).toBe("tvly")
  })

  it("replaces an existing key for the same provider", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { anthropic: { apiKey: "old" } } }),
    })
    setCredential(HOME, "anthropic", "new", m.fsx)
    const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.anthropic.apiKey).toBe("new")
  })

  it("stores a subscription token without wiping an existing api key", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { anthropic: { apiKey: "sk-keep" } } }),
    })
    setCredential(HOME, "anthropic", "oauth-tok", m.fsx, { kind: "authToken" })
    const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.anthropic.apiKey).toBe("sk-keep")
    expect(parsed.providers.anthropic.authToken).toBe("oauth-tok")
  })

  it("rejects an empty key", () => {
    const m = memFs()
    expect(() => setCredential(HOME, "anthropic", "   ", m.fsx)).toThrow(/must not be empty/)
  })

  it("throws on corrupt existing credentials.json", () => {
    const m = memFs({ [credentialsPath(HOME)]: "{bad" })
    expect(() => setCredential(HOME, "anthropic", "sk", m.fsx)).toThrow(/invalid JSON/)
  })
})

describe("search credentials", () => {
  it("sets, lists and deletes search-provider credentials without touching model providers", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { anthropic: { apiKey: "sk-a" } } }),
    })
    setSearchCredential(HOME, "google", "search-key", m.fsx, { cx: "engine" })
    let parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.anthropic.apiKey).toBe("sk-a")
    expect(parsed.searchProviders.google).toEqual({ apiKey: "search-key", cx: "engine" })
    expect(listSearchCredentialProviders(HOME, m.fsx)).toEqual(["google"])

    deleteSearchCredential(HOME, "google", m.fsx)
    parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.anthropic.apiKey).toBe("sk-a")
    expect(parsed.searchProviders.google).toBeUndefined()
  })
})

describe("deleteCredential", () => {
  it("removes one provider's key", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({
        providers: { anthropic: { apiKey: "a" }, openai: { apiKey: "o" } },
      }),
    })
    deleteCredential(HOME, "anthropic", m.fsx)
    const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
    expect(parsed.providers.anthropic).toBeUndefined()
    expect(parsed.providers.openai.apiKey).toBe("o")
  })

  it("is a no-op when the provider has no stored key", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { openai: { apiKey: "o" } } }),
    })
    deleteCredential(HOME, "anthropic", m.fsx)
    expect(m.writes).toHaveLength(0)
  })

  it("is a no-op when no credentials file exists", () => {
    const m = memFs()
    deleteCredential(HOME, "anthropic", m.fsx)
    expect(m.writes).toHaveLength(0)
  })
})

describe("named accounts", () => {
  const read = (m: ReturnType<typeof memFs>) =>
    JSON.parse(m.files.get(credentialsPath(HOME))!) as {
      providers: Record<string, Record<string, unknown> | undefined>
    }

  it("saves a named account beside the default one, keeping both", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({ providers: { openai: { apiKey: "sk-d" } } }),
    })
    setCredential(HOME, "openai", "sk-w", m.fsx, { account: "work" })
    setCredential(HOME, "openai", "tok-w", m.fsx, { account: "work", kind: "authToken" })
    expect(read(m).providers.openai).toEqual({
      apiKey: "sk-d",
      accounts: { work: { apiKey: "sk-w", authToken: "tok-w" } },
    })
    // "default" is the unnamed slot, never a key under accounts.
    setCredential(HOME, "openai", "sk-d2", m.fsx, { account: "default" })
    expect(read(m).providers.openai?.apiKey).toBe("sk-d2")
  })

  it("refuses an account name it could not store", () => {
    expect(() => setCredential(HOME, "openai", "k", memFs().fsx, { account: "has space" })).toThrow(
      /invalid account name/
    )
  })

  it("removes one account, then the provider once nothing is left", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({
        providers: { openai: { apiKey: "sk-d", accounts: { work: { apiKey: "sk-w" } } } },
      }),
    })
    expect(deleteCredential(HOME, "openai", m.fsx, { account: "work" })).toEqual({
      removed: ["work"],
    })
    expect(read(m).providers.openai).toEqual({ apiKey: "sk-d" })
    expect(deleteCredential(HOME, "openai", m.fsx)).toEqual({ removed: ["default"] })
    expect(read(m).providers.openai).toBeUndefined()
  })

  it("says what is stored instead of removing an account that is not", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({
        providers: { openai: { accounts: { a: { apiKey: "1" }, b: { apiKey: "2" } } } },
      }),
    })
    expect(deleteCredential(HOME, "openai", m.fsx)).toEqual({
      removed: [],
      missing: "default",
      stored: ["a", "b"],
    })
    expect(m.writes).toHaveLength(0)
    expect(deleteCredential(HOME, "openai", m.fsx, { all: true })).toEqual({ removed: ["a", "b"] })
    expect(read(m).providers.openai).toBeUndefined()
  })

  it("lists every account with its secret kinds, never the secrets", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({
        providers: {
          openai: { apiKey: "sk-d", accounts: { work: { authToken: "t" } } },
        },
      }),
    })
    const listed = listStoredAccounts(HOME, m.fsx)
    expect(listed).toEqual({
      openai: [
        { name: "default", kinds: ["apiKey"] },
        { name: "work", kinds: ["authToken"] },
      ],
    })
    expect(JSON.stringify(listed)).not.toContain("sk-d")
  })
})

describe("listCredentialProviders", () => {
  it("lists stored provider ids sorted", () => {
    const m = memFs({
      [credentialsPath(HOME)]: JSON.stringify({
        providers: { openai: { apiKey: "o" }, anthropic: { apiKey: "a" } },
      }),
    })
    expect(listCredentialProviders(HOME, m.fsx)).toEqual(["anthropic", "openai"])
  })

  it("returns [] when no credentials file exists", () => {
    const m = memFs()
    expect(listCredentialProviders(HOME, m.fsx)).toEqual([])
  })
})

it("stores every newly supported search credential without changing the others", () => {
  const m = memFs()
  for (const id of ["google-ai", "deepseek", "tinyfish", "searxng"] as const) {
    setSearchCredential(HOME, id, `${id}-key`, m.fsx)
  }
  const parsed = JSON.parse(m.files.get(credentialsPath(HOME))!)
  expect(Object.keys(parsed.searchProviders).sort()).toEqual([
    "deepseek",
    "google-ai",
    "searxng",
    "tinyfish",
  ])
  expect(parsed.searchProviders.tinyfish.apiKey).toBe("tinyfish-key")
  expect(m.writes.every((write) => write.mode === CREDENTIALS_MODE)).toBe(true)
})
