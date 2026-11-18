import { LogtoRefreshError, type LogtoSession } from "@/lib/logto/client"

import { officialDeployment } from "@/lib/identity/official-deployment"

import type { BoundPerson, LogtoSessionFs } from "../config/logto-session"
import {
  clearCollabCursors,
  createCollabCursorStorage,
  startHeadlessCollabReader,
} from "./collab-reader"

function sessionToken(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url")
  return `header.${payload}.signature`
}

function sessionFs(session: LogtoSession | null): LogtoSessionFs {
  let raw = session ? JSON.stringify(session) : null
  return {
    read: () => raw,
    write: (_path, content) => {
      raw = content
    },
    remove: () => {
      raw = null
    },
    mkdirp: () => undefined,
    listDirs: () => [],
  }
}

const ISSUER = "https://issuer.test/oidc"
/** The person the account is bound to (and the Brain pinned at start). */
const pinned =
  (subject: string, issuer = ISSUER): (() => BoundPerson) =>
  () => ({ issuer, subject, boundAt: 1 })

const ORG = "org_acme00000000000000000"
const USER = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

function fetchImpl(url: string): Promise<Response> {
  if (url.endsWith("/grants")) {
    return Promise.resolve(
      Response.json({ grant: "grant", userId: USER, orgId: ORG, expiresAt: 10_000 })
    )
  }
  if (url.endsWith("/memberships/me")) {
    return Promise.resolve(Response.json({ userId: USER, orgRole: "owner", workspaces: [] }))
  }
  return Promise.resolve(Response.json([]))
}

it("stays inactive without the existing 0600 Logto session", async () => {
  const reader = await startHeadlessCollabReader({
    localAccountId: "acct-1",
    cliHome: "/home",
    config: { url: "https://collab.test", orgId: ORG },
    person: pinned("logto-subject"),
    deps: { sessionFs: sessionFs(null) },
  })
  expect(reader.status).toBe("not-signed-in")
})

it("binds the server identity and hands its own credentials to the registered runtimes", async () => {
  const bind = jest.fn().mockResolvedValue({})
  const session = sessionFs({
    issuer: "https://issuer.test/oidc",
    clientId: "brain",
    resource: "collab",
    accessToken: sessionToken("logto-subject"),
    scopes: [],
  })
  const reader = await startHeadlessCollabReader({
    localAccountId: "acct-1",
    cliHome: "/home",
    config: { url: "https://collab.test", orgId: ORG },
    person: pinned("logto-subject"),
    deps: {
      sessionFs: session,
      fetchImpl,
      registry: {
        bind,
        getOwner: jest.fn().mockResolvedValue(null),
        get: jest.fn().mockResolvedValue({ orgId: ORG }),
      } as never,
    },
  })
  expect(reader.status).toBe("active")
  expect(bind).toHaveBeenCalledWith(
    expect.objectContaining({
      localAccountId: "acct-1",
      userId: USER,
      orgId: ORG,
      logtoSubject: "logto-subject",
    })
  )
  const resolved = await reader.runtime!.resolve("acct-1")
  expect(resolved?.orgId).toBe(ORG)
  expect(resolved?.client.baseUrl).toBe("https://collab.test")
  expect(await reader.runtime!.resolve("another-account")).toBeNull()
  session.remove("/home/logto.json")
  expect(await reader.runtime!.resolve("acct-1")).toBeNull()
  reader.stop()
})

it("never acts under this profile with a token for another person signed in since", async () => {
  const bind = jest.fn().mockResolvedValue({})
  const session = sessionFs({
    issuer: "https://issuer.test/oidc",
    clientId: "brain",
    resource: "collab",
    accessToken: sessionToken("person-a"),
    scopes: [],
  })
  const presented: string[] = []
  let now = 0
  const reader = await startHeadlessCollabReader({
    localAccountId: "acct-1",
    cliHome: "/home",
    config: { url: "https://collab.test", orgId: ORG },
    person: pinned("person-a"),
    deps: {
      sessionFs: session,
      now: () => now,
      fetchImpl: (url: string, init?: RequestInit) => {
        presented.push(String((init?.headers as Record<string, string>)?.authorization ?? ""))
        return fetchImpl(url)
      },
      registry: {
        bind,
        getOwner: jest.fn().mockResolvedValue(null),
        get: jest.fn().mockResolvedValue({ orgId: ORG, userId: USER }),
      } as never,
    },
  })
  expect(reader.status).toBe("active")
  // Another terminal signs in as B; the reader's grant for A expires.
  session.write(
    "/home/logto.json",
    JSON.stringify({
      issuer: "https://issuer.test/oidc",
      clientId: "brain",
      resource: "collab",
      accessToken: sessionToken("person-b"),
      scopes: [],
    }),
    0o600
  )
  now = 20_000_000
  presented.length = 0
  expect(await reader.runtime!.resolve("acct-1")).toBeNull()
  await reader.runtime!.refreshAll()
  expect(presented.some((header) => header.includes(sessionToken("person-b")))).toBe(false)
  // A signs back in: the profile works again with A's own token.
  session.write(
    "/home/logto.json",
    JSON.stringify({
      issuer: "https://issuer.test/oidc",
      clientId: "brain",
      resource: "collab",
      accessToken: sessionToken("person-a"),
      scopes: [],
    }),
    0o600
  )
  expect(await reader.runtime!.resolve("acct-1")).not.toBeNull()
  reader.stop()
})

describe("the person the account is bound to", () => {
  const stored = (sub: string, issuer = ISSUER): LogtoSession => ({
    issuer,
    clientId: "brain",
    resource: "collab",
    accessToken: sessionToken(sub),
    scopes: [],
  })

  it("stays inactive when the session signs in as someone other than the pinned person", async () => {
    const reader = await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      person: pinned("person-a"),
      deps: { sessionFs: sessionFs(stored("person-b")), fetchImpl },
    })
    expect(reader.status).toBe("not-signed-in")
  })

  it("stays inactive for an account that was never bound", async () => {
    const reader = await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      person: () => null,
      deps: { sessionFs: sessionFs(stored("person-a")), fetchImpl },
    })
    expect(reader.status).toBe("not-signed-in")
  })

  it("rebinds the profile to the account's new person and clears the old person's cursors", async () => {
    const bind = jest.fn()
    const rebind = jest.fn().mockResolvedValue({})
    const cursors = new Map<string, string>([
      ["/home/collab-notifications/acct-1.json", JSON.stringify({ scope: "ann's cursor" })],
    ])
    const reader = await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      person: () => ({ issuer: ISSUER, subject: "person-b", displayName: "Bob", boundAt: 9 }),
      deps: {
        sessionFs: sessionFs(stored("person-b")),
        fetchImpl,
        cursorFs: {
          readFile: (file) => cursors.get(file) ?? null,
          writeFileAtomic: (file, value) => {
            cursors.set(file, value)
          },
        },
        registry: {
          bind,
          rebind,
          getOwner: jest.fn().mockResolvedValue({
            localAccountId: "acct-1",
            userId: "usr_ann",
            displayName: "Ann",
            logtoSubject: "person-a",
            logtoIssuer: `${ISSUER}/`,
          }),
          get: jest.fn().mockResolvedValue({ orgId: ORG, userId: USER }),
        } as never,
      },
    })
    expect(reader.status).toBe("active")
    expect(bind).not.toHaveBeenCalled()
    expect(rebind).toHaveBeenCalledWith(
      expect.objectContaining({ logtoSubject: "person-b", userId: USER, displayName: "Bob" })
    )
    expect(reader.rebound).toEqual({ from: "Ann (usr_ann)", to: "Bob (person-b)" })
    expect(cursors.get("/home/collab-notifications/acct-1.json")).toBe("{}")
  })

  it("keeps the binding of the same person, at an issuer spelled with a trailing slash", async () => {
    const bind = jest.fn().mockResolvedValue({})
    const rebind = jest.fn()
    await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      person: pinned("person-a"),
      deps: {
        sessionFs: sessionFs(stored("person-a")),
        fetchImpl,
        registry: {
          bind,
          rebind,
          getOwner: jest.fn().mockResolvedValue({
            userId: USER,
            logtoSubject: "person-a",
            logtoIssuer: `${ISSUER}/`,
          }),
          get: jest.fn().mockResolvedValue({ orgId: ORG, userId: USER }),
        } as never,
      },
    })
    expect(bind).toHaveBeenCalled()
    expect(rebind).not.toHaveBeenCalled()
  })

  it("says the Cognia account is the wrong deployment when the collaboration server refuses it", async () => {
    const official = officialDeployment({})!.issuer
    await expect(
      startHeadlessCollabReader({
        localAccountId: "acct-1",
        cliHome: "/home",
        config: { url: "https://collab.test", orgId: ORG },
        person: pinned("usr_a", official),
        env: {},
        deps: {
          sessionFs: sessionFs(stored("usr_a", official)),
          fetchImpl: async () => new Response("no", { status: 401 }),
        },
      })
    ).rejects.toThrow(
      /account acct-1 is signed in to the Cognia account, which the collaboration server at https:\/\/collab\.test does not accept/
    )
  })

  it("clears an account's cursors on request", () => {
    const values = new Map<string, string>([["/home/collab-notifications/a%2Fb.json", '{"x":"1"}']])
    clearCollabCursors("/home", "a/b", {
      readFile: (file) => values.get(file) ?? null,
      writeFileAtomic: (file, value) => {
        values.set(file, value)
      },
    })
    expect(values.get("/home/collab-notifications/a%2Fb.json")).toBe("{}")
  })
})

describe("durable collaboration notification cursors", () => {
  function files() {
    const values = new Map<string, string>()
    return {
      values,
      fs: {
        readFile: (file: string) => values.get(file) ?? null,
        writeFileAtomic: (file: string, value: string) => {
          values.set(file, value)
        },
      },
    }
  }

  it("survives adapter recreation and isolates profiles", () => {
    const { fs } = files()
    const first = createCollabCursorStorage("/home", "acct-1", fs)
    first.setItem("scope", JSON.stringify({ cursor: { afterSeq: 7 }, pendingReadIds: ["n1"] }))
    const reopened = createCollabCursorStorage("/home", "acct-1", fs)
    expect(reopened.getItem("scope")).toBe(first.getItem("scope"))
    expect(createCollabCursorStorage("/home", "acct-2", fs).getItem("scope")).toBeNull()
    reopened.removeItem("scope")
    expect(first.getItem("scope")).toBeNull()
  })

  it.each(["{broken", "[]", '{"scope":123}'])("recovers %s as a quiet first pull", (raw) => {
    const { fs, values } = files()
    values.set("/home/collab-notifications/acct-1.json", raw)
    const local = createCollabCursorStorage("/home", "acct-1", fs)
    expect(local.getItem("scope")).toBeNull()
    local.setItem("scope", "recovered")
    expect(local.getItem("scope")).toBe("recovered")
  })
})

describe("a refresh that is refused vs one that merely failed", () => {
  const stale: LogtoSession = {
    issuer: "https://issuer.test/oidc",
    clientId: "brain",
    resource: "collab",
    accessToken: sessionToken("logto-subject"),
    refreshToken: "rt",
    expiresAt: 1,
    scopes: [],
  }

  it("removes the session file on invalid_grant, so no later poll presents a dead token", async () => {
    const fs = sessionFs(stale)
    const refreshToken = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "refused", { oauthError: "invalid_grant" })
    })
    const reader = await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      person: pinned("logto-subject"),
      deps: { sessionFs: fs, refreshToken, now: () => 10_000 },
    })
    expect(reader.status).toBe("not-signed-in")
    expect(fs.read("/home/logto.json")).toBeNull()
  })

  it("never treats an untyped throw as a revocation", async () => {
    const fs = sessionFs(stale)
    const refreshToken = jest.fn(async () => {
      throw new Error("something else")
    })
    const reader = await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      person: pinned("logto-subject"),
      deps: { sessionFs: fs, refreshToken, now: () => 10_000 },
    })
    expect(reader.status).toBe("not-signed-in")
    expect(fs.read("/home/logto.json")).not.toBeNull()
  })

  it("keeps the file when the issuer was merely unreachable, and hands out no token", async () => {
    const fs = sessionFs(stale)
    const refreshToken = jest.fn(async () => {
      throw new LogtoRefreshError("network", "down")
    })
    const reader = await startHeadlessCollabReader({
      localAccountId: "acct-1",
      cliHome: "/home",
      config: { url: "https://collab.test", orgId: ORG },
      person: pinned("logto-subject"),
      deps: { sessionFs: fs, refreshToken, now: () => 10_000 },
    })
    expect(reader.status).toBe("not-signed-in")
    expect(fs.read("/home/logto.json")).not.toBeNull()
  })
})
