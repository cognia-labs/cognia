/**
 * @jest-environment node
 */
import type { LogtoClientConfig, LogtoDrivers, LogtoSession } from "@/lib/logto/client"

import type { LogtoSessionFs } from "../config/logto-session"

import path from "node:path"

import { parseArgv } from "./args"
import { logtoCommand } from "./logto-command"

function captureOut() {
  const lines: string[] = []
  const errs: string[] = []
  return {
    sink: {
      write: (s: string) => lines.push(s),
      error: (s: string) => errs.push(s),
      json: (obj: unknown) => lines.push(JSON.stringify(obj) + "\n"),
    },
    text: () => lines.join(""),
    errText: () => errs.join(""),
  }
}

function memFs(seed?: Record<string, string>): LogtoSessionFs & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    store,
    read: (p) => store.get(p) ?? null,
    write: (p, c) => {
      store.set(p, c)
    },
    remove: (p) => {
      store.delete(p)
    },
    mkdirp: () => {},
    // Directories exist where files do; enough for listing the accounts.
    listDirs: (dir) => {
      const prefix = `${dir}${path.sep}`
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length).split(path.sep)
        if (rest.length > 1) names.add(rest[0]!)
      }
      return [...names]
    },
  }
}

/** An unsigned JWT; the CLI reads claims but never verifies (the Host does). */
function jwtFor(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`
}

function fakeServer() {
  return {
    redirectUrl: "http://127.0.0.1:9321/callback",
    waitForCode: jest.fn(async () => ({ code: "the-code", state: "st" })),
    close: jest.fn(),
  }
}

const HOME = "/home/u/.cognia"
// Build the expected paths the same way the source does (path.join), so the
// store keys match on both POSIX and Windows separators.
const ACCOUNT_DIR = path.join(HOME, "accounts", "local_acct_a")
const SESSION_FILE = path.join(ACCOUNT_DIR, "logto.json")
const PERSON_FILE = path.join(ACCOUNT_DIR, "person.json")
const sampleSession: LogtoSession = {
  issuer: "https://logto.test/oidc",
  clientId: "cli-1",
  resource: "https://brain.test/api",
  organizationId: "org_9",
  accessToken: jwtFor({ sub: "usr_ann", jti: "ATK-secret-xyz" }),
  refreshToken: "RTK-secret-xyz",
  expiresAt: 1893456000000,
  scopes: ["brain:rpc"],
}

describe("logtoCommand", () => {
  it("login: runs the PKCE flow with flag config and persists the session", async () => {
    const cap = captureOut()
    const fs = memFs()
    const server = fakeServer()
    const login = jest.fn<Promise<LogtoSession>, [LogtoClientConfig, LogtoDrivers]>(
      async () => sampleSession
    )
    const openBrowser = jest.fn(async () => true)

    const code = await logtoCommand(
      parseArgv([
        "logto",
        "login",
        "--issuer",
        "https://logto.test/oidc",
        "--client-id",
        "cli-1",
        "--resource",
        "https://brain.test/api",
        "--scope",
        "brain:rpc,brain:read",
        "--org",
        "org_9",
      ]),
      {
        home: HOME,
        out: cap.sink,
        sessionFs: fs,
        login,
        startCallbackServer: async () => server as never,
        openBrowser,
        env: {},
      }
    )

    expect(code).toBe(0)
    const [cfg, drivers] = login.mock.calls[0]
    expect(cfg).toMatchObject({
      issuer: "https://logto.test/oidc",
      clientId: "cli-1",
      resource: "https://brain.test/api",
      organizationId: "org_9",
      redirectUri: "http://127.0.0.1:9321/callback",
    })
    expect(cfg.scopes).toEqual(["brain:rpc", "brain:read"])
    expect(JSON.parse(fs.store.get(SESSION_FILE)!)).toEqual(sampleSession)
    expect(server.close).toHaveBeenCalled()
    await expect(drivers.waitForCode({ redirectUri: "x", state: "st" })).resolves.toEqual({
      code: "the-code",
      state: "st",
    })
  })

  it("login: reads config from env when flags are absent", async () => {
    const cap = captureOut()
    const login = jest.fn<Promise<LogtoSession>, [LogtoClientConfig, LogtoDrivers]>(
      async () => sampleSession
    )
    const code = await logtoCommand(parseArgv(["logto", "login"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: memFs(),
      login,
      startCallbackServer: async () => fakeServer() as never,
      openBrowser: async () => true,
      env: {
        COGNIA_LOGTO_ISSUER: "https://logto.test/oidc",
        COGNIA_LOGTO_CLIENT_ID: "cli-1",
        COGNIA_LOGTO_AUDIENCE: "https://brain.test/api",
      },
    })
    expect(code).toBe(0)
    expect(login.mock.calls[0][0]).toMatchObject({
      issuer: "https://logto.test/oidc",
      clientId: "cli-1",
      resource: "https://brain.test/api",
    })
  })

  it("login: exits 2 when only part of a Logto configuration is named", async () => {
    const cap = captureOut()
    const code = await logtoCommand(
      parseArgv(["logto", "login", "--issuer", "https://logto.test/oidc"]),
      { home: HOME, out: cap.sink, env: {} }
    )
    expect(code).toBe(2)
    expect(cap.errText()).toMatch(/--issuer/)
  })

  it("login: signs in to the official Cognia account when no issuer is named", async () => {
    const cap = captureOut()
    const fs = memFs()
    const officialSession: LogtoSession = {
      ...sampleSession,
      issuer: "https://id.cognia.cn/api/auth",
      organizationId: undefined,
      issuerKind: "oidc",
    }
    const login = jest.fn<Promise<LogtoSession>, [LogtoClientConfig, LogtoDrivers]>(
      async () => officialSession
    )
    const code = await logtoCommand(parseArgv(["logto", "login", "--provider", "feishu"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: fs,
      login,
      startCallbackServer: async () => fakeServer() as never,
      openBrowser: async () => true,
      env: {},
    })
    expect(code).toBe(0)
    expect(login.mock.calls[0][0]).toEqual({
      issuer: "https://id.cognia.cn/api/auth",
      clientId: "cognia-app",
      redirectUri: "http://127.0.0.1:9321/callback",
      resource: "https://sync.cognia.cn",
      scopes: ["profile", "email"],
      issuerKind: "oidc",
      socialProvider: "feishu",
    })
    expect(cap.text()).toMatch(/Signed in to your Cognia account/)
    expect(JSON.parse(fs.store.get(SESSION_FILE)!).issuerKind).toBe("oidc")
  })

  it("login: points the official account at COGNIA_ID_ISSUER for staging or a local Worker", async () => {
    const login = jest.fn<Promise<LogtoSession>, [LogtoClientConfig, LogtoDrivers]>(
      async () => sampleSession
    )
    await logtoCommand(parseArgv(["logto", "login"]), {
      home: HOME,
      out: captureOut().sink,
      sessionFs: memFs(),
      login,
      startCallbackServer: async () => fakeServer() as never,
      openBrowser: async () => true,
      env: {
        COGNIA_ID_ISSUER: "http://localhost:8787/api/auth",
        COGNIA_ID_AUDIENCE: "https://sync-staging.cognia.cn",
      },
    })
    expect(login.mock.calls[0][0]).toMatchObject({
      issuer: "http://localhost:8787/api/auth",
      resource: "https://sync-staging.cognia.cn",
      clientId: "cognia-app",
    })
    expect(login.mock.calls[0][0].socialProvider).toBeUndefined()
  })

  it("login: refuses a provider the official account does not offer, or one aimed at Logto", async () => {
    const startCallbackServer = jest.fn()
    const unknown = captureOut()
    expect(
      await logtoCommand(parseArgv(["logto", "login", "--provider", "wechat"]), {
        home: HOME,
        out: unknown.sink,
        env: {},
        startCallbackServer,
      })
    ).toBe(2)
    expect(unknown.errText()).toMatch(/feishu, github, google, apple/)

    const logto = captureOut()
    expect(
      await logtoCommand(parseArgv(["logto", "login", "--provider", "github"]), {
        home: HOME,
        out: logto.sink,
        env: {
          COGNIA_LOGTO_ISSUER: "https://logto.test/oidc",
          COGNIA_LOGTO_CLIENT_ID: "c",
          COGNIA_LOGTO_AUDIENCE: "r",
        },
        startCallbackServer,
      })
    ).toBe(2)
    expect(logto.errText()).toMatch(/official Cognia account only/)

    const org = captureOut()
    expect(
      await logtoCommand(parseArgv(["logto", "login", "--org", "org_1"]), {
        home: HOME,
        out: org.sink,
        env: {},
        startCallbackServer,
      })
    ).toBe(2)
    // Scopes would be dropped silently on the official path, so they are refused.
    const scope = captureOut()
    expect(
      await logtoCommand(parseArgv(["logto", "login"]), {
        home: HOME,
        out: scope.sink,
        env: { COGNIA_LOGTO_SCOPES: "brain:rpc" },
        startCallbackServer,
      })
    ).toBe(2)
    expect(scope.errText()).toMatch(/--scope/)
    expect(startCallbackServer).not.toHaveBeenCalled()
  })

  it("status: names the official account for an oidc session", async () => {
    const cap = captureOut()
    await logtoCommand(parseArgv(["logto", "status"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: memFs({
        [SESSION_FILE]: JSON.stringify({ ...sampleSession, issuerKind: "oidc" }),
      }),
      env: {},
      now: () => 0,
    })
    expect(cap.text()).toMatch(/deployment: your Cognia account/)
  })

  it("login: exits 1 and closes the server when the flow throws", async () => {
    const cap = captureOut()
    const server = fakeServer()
    const login = jest.fn(async () => {
      throw new Error("boom")
    })
    const code = await logtoCommand(
      parseArgv(["logto", "login", "--issuer", "i", "--client-id", "c", "--resource", "r"]),
      {
        home: HOME,
        out: cap.sink,
        sessionFs: memFs(),
        login,
        startCallbackServer: async () => server as never,
        openBrowser: async () => true,
        env: {},
      }
    )
    expect(code).toBe(1)
    expect(cap.errText()).toMatch(/boom/)
    expect(server.close).toHaveBeenCalled()
  })

  it("login: prints the URL as a fallback when the browser cannot open", async () => {
    const cap = captureOut()
    const login = jest.fn(
      async (_cfg: unknown, drivers: { openUrl: (u: string) => Promise<void> | void }) => {
        await drivers.openUrl("https://logto.test/oidc/auth?x=1")
        return sampleSession
      }
    )
    await logtoCommand(
      parseArgv(["logto", "login", "--issuer", "i", "--client-id", "c", "--resource", "r"]),
      {
        home: HOME,
        out: cap.sink,
        sessionFs: memFs(),
        login,
        startCallbackServer: async () => fakeServer() as never,
        openBrowser: async () => false,
        env: {},
      }
    )
    expect(cap.text()).toMatch(/logto\.test\/oidc\/auth/)
  })

  it("status: prints the session summary without leaking tokens", async () => {
    const cap = captureOut()
    const fs = memFs({ [SESSION_FILE]: JSON.stringify(sampleSession) })
    const code = await logtoCommand(parseArgv(["logto", "status"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: fs,
      env: {},
    })
    expect(code).toBe(0)
    expect(cap.text()).toMatch(/https:\/\/brain\.test\/api/)
    expect(cap.text()).toMatch(/org_9/)
    expect(cap.text()).not.toContain(sampleSession.accessToken)
    expect(cap.text()).not.toContain("RTK-secret-xyz")
  })

  it("status: reports not-signed-in when there is no session", async () => {
    const cap = captureOut()
    const code = await logtoCommand(parseArgv(["logto", "status"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: memFs(),
      env: {},
    })
    expect(code).toBe(0)
    expect(cap.text()).toMatch(/No local account has signed in/)
    expect(cap.text()).toMatch(/logto login \[--account <id>\]/)
  })

  it("logout: revokes both tokens at the issuer, then removes the session file", async () => {
    const cap = captureOut()
    const fs = memFs({ [SESSION_FILE]: JSON.stringify(sampleSession) })
    const revoke = jest.fn(async () => ({ status: "revoked" as const }))
    const code = await logtoCommand(parseArgv(["logto", "logout"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: fs,
      env: {},
      revoke,
    })
    expect(code).toBe(0)
    expect(fs.store.has(SESSION_FILE)).toBe(false)
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(revoke.mock.calls[0]).toEqual([
      sampleSession,
      "RTK-secret-xyz",
      "refresh_token",
      undefined,
    ])
    expect(revoke.mock.calls[1]).toEqual([
      sampleSession,
      sampleSession.accessToken,
      "access_token",
      undefined,
    ])
    expect(cap.text()).toMatch(/revoked/i)
  })

  it("logout: an official access token that only expires is not reported as a failure", async () => {
    const cap = captureOut()
    const fs = memFs({
      [SESSION_FILE]: JSON.stringify({ ...sampleSession, issuerKind: "oidc" }),
    })
    const revoke = jest
      .fn()
      .mockResolvedValueOnce({ status: "revoked" })
      .mockResolvedValueOnce({ status: "self-expiring" })
    expect(
      await logtoCommand(parseArgv(["logto", "logout"]), {
        home: HOME,
        out: cap.sink,
        sessionFs: fs,
        env: {},
        revoke,
      })
    ).toBe(0)
    expect(cap.text()).toMatch(/^Signed out of your Cognia account/)
    expect(cap.text()).toMatch(/expires on its own/)
    expect(cap.text()).not.toMatch(/could not be told/)
  })

  it("logout: still removes the file when the issuer cannot be reached, and says so", async () => {
    const cap = captureOut()
    const fs = memFs({ [SESSION_FILE]: JSON.stringify(sampleSession) })
    const code = await logtoCommand(parseArgv(["logto", "logout"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: fs,
      env: {},
      revoke: jest.fn(async () => ({ status: "failed" as const, reason: "ECONNREFUSED" })),
    })
    expect(code).toBe(0)
    expect(fs.store.has(SESSION_FILE)).toBe(false)
    expect(cap.text()).toMatch(/could not be told to revoke/i)
    expect(cap.text()).toContain("ECONNREFUSED")
  })

  it("logout: says when the issuer offers no revocation endpoint", async () => {
    const cap = captureOut()
    const fs = memFs({ [SESSION_FILE]: JSON.stringify(sampleSession) })
    const code = await logtoCommand(parseArgv(["logto", "logout"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: fs,
      env: {},
      revoke: jest.fn(async () => ({ status: "unsupported" as const })),
    })
    expect(code).toBe(0)
    expect(fs.store.has(SESSION_FILE)).toBe(false)
    expect(cap.text()).toMatch(/no revocation endpoint/i)
  })

  it("status: an expired access token with a refresh token will refresh on next use", async () => {
    const cap = captureOut()
    const expired = { ...sampleSession, expiresAt: 1 }
    await logtoCommand(parseArgv(["logto", "status"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: memFs({ [SESSION_FILE]: JSON.stringify(expired) }),
      env: {},
      now: () => 2,
    })
    expect(cap.text()).toMatch(/refreshes on next use/i)
    expect(cap.text()).not.toContain("RTK-secret-xyz")
  })

  it("logout: is a no-op without a session", async () => {
    const cap = captureOut()
    const revoke = jest.fn()
    const code = await logtoCommand(parseArgv(["logto", "logout"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: memFs(),
      env: {},
      revoke,
    })
    expect(code).toBe(0)
    expect(revoke).not.toHaveBeenCalled()
    expect(cap.text()).toMatch(/not signed in/i)
  })

  it("status: names an expired session instead of calling it signed in", async () => {
    const cap = captureOut()
    const expired = { ...sampleSession, expiresAt: 1, refreshToken: undefined }
    const code = await logtoCommand(parseArgv(["logto", "status"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: memFs({ [SESSION_FILE]: JSON.stringify(expired) }),
      env: {},
      now: () => 2,
    })
    expect(code).toBe(0)
    expect(cap.text()).toMatch(/expired/i)
    expect(cap.text()).toMatch(/logto login/)
  })

  it("errors on an unknown subcommand", async () => {
    const cap = captureOut()
    const code = await logtoCommand(parseArgv(["logto", "frobnicate"]), {
      home: HOME,
      out: cap.sink,
      env: {},
    })
    expect(code).toBe(2)
    expect(cap.errText()).toMatch(/login \| status \| logout/)
  })

  /** A JWT-shaped token whose payload names `sub` (signature is never checked here). */
  function tokenFor(sub: string): string {
    return `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`
  }

  function officialArgs(...extra: string[]) {
    return parseArgv(["logto", "login", ...extra])
  }

  it("login: an earlier sign-in that finishes last is discarded and its tokens revoked", async () => {
    const fs = memFs()
    const revoke = jest.fn(async () => ({ status: "revoked" as const }))
    const finishFirst: Array<(session: LogtoSession) => void> = []
    const firstSession = { ...sampleSession, accessToken: tokenFor("usr_a"), refreshToken: "RTK-a" }
    const secondSession = {
      ...sampleSession,
      accessToken: tokenFor("usr_b"),
      refreshToken: "RTK-b",
    }
    const firstOut = captureOut()
    const first = logtoCommand(officialArgs(), {
      home: HOME,
      out: firstOut.sink,
      sessionFs: fs,
      revoke,
      login: () => new Promise<LogtoSession>((resolve) => finishFirst.push(resolve)),
      startCallbackServer: async () => fakeServer() as never,
      openBrowser: async () => true,
      env: {},
    })
    await new Promise((resolve) => setImmediate(resolve))
    const secondOut = captureOut()
    const second = await logtoCommand(officialArgs(), {
      home: HOME,
      out: secondOut.sink,
      sessionFs: fs,
      revoke,
      login: async () => secondSession,
      startCallbackServer: async () => fakeServer() as never,
      openBrowser: async () => true,
      env: {},
    })
    expect(second).toBe(0)
    expect(secondOut.text()).toMatch(/as usr_b/)
    finishFirst[0]!(firstSession)
    expect(await first).toBe(1)
    expect(firstOut.errText()).toMatch(/discarded/)
    expect(JSON.parse(fs.store.get(SESSION_FILE)!).accessToken).toBe(secondSession.accessToken)
    expect(revoke.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      "RTK-a",
      firstSession.accessToken,
    ])
  })

  it("logout: keeps a sign-in that was saved while the old tokens were being revoked", async () => {
    const fs = memFs({ [SESSION_FILE]: JSON.stringify(sampleSession) })
    const newer = { ...sampleSession, accessToken: tokenFor("usr_b") }
    const revoke = jest.fn(async () => {
      // Another terminal finished `logto login` meanwhile.
      fs.store.set(SESSION_FILE, JSON.stringify(newer))
      return { status: "revoked" as const }
    })
    const cap = captureOut()
    const code = await logtoCommand(parseArgv(["logto", "logout"]), {
      home: HOME,
      out: cap.sink,
      sessionFs: fs,
      env: {},
      revoke,
    })
    expect(code).toBe(0)
    expect(JSON.parse(fs.store.get(SESSION_FILE)!).accessToken).toBe(newer.accessToken)
    expect(cap.text()).toMatch(/newer sign-in was saved meanwhile and is kept/)
  })

  it("logout: supersedes a sign-in still waiting for its browser", async () => {
    const fs = memFs()
    let finish!: (session: LogtoSession) => void
    const pending = logtoCommand(officialArgs(), {
      home: HOME,
      out: captureOut().sink,
      sessionFs: fs,
      revoke: async () => ({ status: "revoked" as const }),
      login: () => new Promise<LogtoSession>((resolve) => (finish = resolve)),
      startCallbackServer: async () => fakeServer() as never,
      openBrowser: async () => true,
      env: {},
    })
    await new Promise((resolve) => setImmediate(resolve))
    await logtoCommand(parseArgv(["logto", "logout"]), {
      home: HOME,
      out: captureOut().sink,
      sessionFs: fs,
      env: {},
    })
    finish(sampleSession)
    expect(await pending).toBe(1)
    expect(fs.store.has(SESSION_FILE)).toBe(false)
  })

  it("login --switch-account forces the official issuer to authenticate again", async () => {
    const login = jest.fn<Promise<LogtoSession>, [LogtoClientConfig, LogtoDrivers]>(async () => ({
      ...sampleSession,
      issuerKind: "oidc",
    }))
    const code = await logtoCommand(officialArgs("--switch-account"), {
      home: HOME,
      out: captureOut().sink,
      sessionFs: memFs(),
      login,
      startCallbackServer: async () => fakeServer() as never,
      openBrowser: async () => true,
      env: {},
    })
    expect(code).toBe(0)
    expect(login.mock.calls[0][0].freshLogin).toBe(true)
    const refused = captureOut()
    expect(
      await logtoCommand(
        officialArgs(
          "--switch-account",
          "--issuer",
          "https://l",
          "--client-id",
          "c",
          "--resource",
          "r"
        ),
        { home: HOME, out: refused.sink, sessionFs: memFs(), env: {} }
      )
    ).toBe(2)
    expect(refused.errText()).toMatch(/official Cognia account only/)
  })

  it("status and logout name the signed-in person and how to switch", async () => {
    const official = {
      ...sampleSession,
      accessToken: tokenFor("usr_a"),
      issuerKind: "oidc" as const,
    }
    const fs = memFs({ [SESSION_FILE]: JSON.stringify(official) })
    const status = captureOut()
    await logtoCommand(parseArgv(["logto", "status"]), {
      home: HOME,
      out: status.sink,
      sessionFs: fs,
      env: {},
    })
    expect(status.text()).toMatch(/person: {5}usr_a/)
    const logout = captureOut()
    await logtoCommand(parseArgv(["logto", "logout"]), {
      home: HOME,
      out: logout.sink,
      sessionFs: fs,
      env: {},
      revoke: async () => ({ status: "revoked" as const }),
    })
    expect(logout.text()).toMatch(/still acts for this person/)
    expect(logout.text()).toMatch(/--account <id>.*--rebind.*--switch-account/s)
    expect(fs.store.has(SESSION_FILE)).toBe(false)
  })

  describe("one sign-in per local account", () => {
    const ann = {
      ...sampleSession,
      accessToken: jwtFor({ sub: "usr_ann" }),
      refreshToken: "RTK-ann",
    }
    const bob = {
      ...sampleSession,
      accessToken: jwtFor({ sub: "usr_bob" }),
      idToken: jwtFor({ name: "Bob", email: "bob@example.com" }),
      refreshToken: "RTK-bob",
    }
    const bound = {
      issuer: sampleSession.issuer,
      subject: "usr_ann",
      userId: "usr_ann",
      displayName: "Ann",
      boundAt: 1,
    }

    function signIn(session: LogtoSession, fs: ReturnType<typeof memFs>, ...extra: string[]) {
      const out = captureOut()
      const revoke = jest.fn(async () => ({ status: "revoked" as const }))
      const result = logtoCommand(parseArgv(["logto", "login", ...extra]), {
        home: HOME,
        out: out.sink,
        sessionFs: fs,
        revoke,
        login: async () => session,
        startCallbackServer: async () => fakeServer() as never,
        openBrowser: async () => true,
        env: {},
        now: () => 50,
      })
      return { out, revoke, result }
    }

    it("binds the account on its first sign-in", async () => {
      const fs = memFs()
      const { out, result } = signIn(ann, fs)
      expect(await result).toBe(0)
      expect(out.text()).toMatch(/for account local_acct_a; the account now acts for this person/)
      expect(JSON.parse(fs.store.get(PERSON_FILE)!)).toMatchObject({
        subject: "usr_ann",
        boundAt: 50,
      })
    })

    it("refuses someone else, revokes their tokens and keeps the account's session", async () => {
      const fs = memFs({
        [SESSION_FILE]: JSON.stringify(ann),
        [PERSON_FILE]: JSON.stringify(bound),
      })
      const { out, revoke, result } = signIn(bob, fs)
      expect(await result).toBe(1)
      expect(out.errText()).toMatch(
        /account local_acct_a acts for Ann \(usr_ann\) at Logto https:\/\/logto\.test\/oidc; this sign-in was Bob <bob@example\.com> \(usr_bob\)/
      )
      expect(out.errText()).toMatch(/use another --account for this one, or pass --rebind/)
      expect(out.errText()).toMatch(/Its tokens were revoked/)
      expect(revoke.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
        "RTK-bob",
        bob.accessToken,
      ])
      expect(JSON.parse(fs.store.get(SESSION_FILE)!).accessToken).toBe(ann.accessToken)
      expect(JSON.parse(fs.store.get(PERSON_FILE)!).subject).toBe("usr_ann")
    })

    it("--rebind hands the account over and says what follows", async () => {
      const fs = memFs({
        [SESSION_FILE]: JSON.stringify(ann),
        [PERSON_FILE]: JSON.stringify(bound),
      })
      const { out, revoke, result } = signIn(bob, fs, "--rebind")
      expect(await result).toBe(0)
      expect(out.text()).toMatch(/now acts for this person instead of Ann \(usr_ann\)/)
      expect(out.text()).toMatch(/keeps acting for the previous person until it restarts/)
      expect(out.text()).toMatch(
        /account-sync data --merge` or `--replace` \(with --account local_acct_a\)/
      )
      expect(revoke).not.toHaveBeenCalled()
      expect(JSON.parse(fs.store.get(PERSON_FILE)!).subject).toBe("usr_bob")
      expect(JSON.parse(fs.store.get(SESSION_FILE)!).accessToken).toBe(bob.accessToken)
    })

    it("refuses a token that names nobody, and revokes it", async () => {
      const fs = memFs()
      const { out, revoke, result } = signIn({ ...ann, accessToken: "opaque" }, fs)
      expect(await result).toBe(1)
      expect(out.errText()).toMatch(
        /names no subject, so there is nobody to bind account local_acct_a to/
      )
      expect(revoke).toHaveBeenCalledTimes(2)
      expect(fs.store.size).toBe(0)
    })

    it("--account keeps a second person in their own account", async () => {
      const fs = memFs({
        [SESSION_FILE]: JSON.stringify(ann),
        [PERSON_FILE]: JSON.stringify(bound),
      })
      const { result } = signIn(bob, fs, "--account", "work")
      expect(await result).toBe(0)
      const work = path.join(HOME, "accounts", "work")
      expect(JSON.parse(fs.store.get(path.join(work, "person.json"))!).subject).toBe("usr_bob")
      expect(JSON.parse(fs.store.get(SESSION_FILE)!).accessToken).toBe(ann.accessToken)
    })

    it("refuses --account without a value", async () => {
      const out = captureOut()
      expect(
        await logtoCommand(parseArgv(["logto", "status", "--account"]), {
          home: HOME,
          out: out.sink,
          sessionFs: memFs(),
          env: { COGNIA_LOCAL_ACCOUNT_ID: "work" },
        })
      ).toBe(2)
      expect(out.errText()).toMatch(/--account needs a value/)
    })

    it("status lists every account and marks the one this shell acts for", async () => {
      const work = path.join(HOME, "accounts", "work")
      const fs = memFs({
        [SESSION_FILE]: JSON.stringify(ann),
        [PERSON_FILE]: JSON.stringify(bound),
        [path.join(work, "person.json")]: JSON.stringify({
          ...bound,
          subject: "usr_bob",
          displayName: "Bob",
        }),
      })
      const out = captureOut()
      await logtoCommand(parseArgv(["logto", "status"]), {
        home: HOME,
        out: out.sink,
        sessionFs: fs,
        env: { COGNIA_LOCAL_ACCOUNT_ID: "work" },
        now: () => 0,
      })
      const text = out.text()
      expect(text).toMatch(
        /Account local_acct_a\n {2}state: {6}signed in\n {2}person: {5}Ann \(usr_ann\)/
      )
      expect(text).toMatch(
        /Account work {2}\(selected by COGNIA_LOCAL_ACCOUNT_ID\)\n {2}state: {6}signed out\n {2}person: {5}Bob \(usr_bob\)/
      )
      expect(text).not.toContain(ann.accessToken)

      const json = captureOut()
      await logtoCommand(parseArgv(["logto", "status", "--json"]), {
        home: HOME,
        out: json.sink,
        sessionFs: fs,
        env: {},
        now: () => 0,
      })
      const parsed = JSON.parse(json.text()) as { accounts: Array<Record<string, unknown>> }
      expect(parsed.accounts.map((a) => [a.account, a.state, a.selected])).toEqual([
        ["local_acct_a", "signed-in", true],
        ["work", "signed-out", false],
      ])
      expect(parsed.accounts[0]).toMatchObject({
        selectedBy: "default",
        person: { subject: "usr_ann", boundAt: new Date(1).toISOString() },
        session: { resource: sampleSession.resource, organizationId: "org_9" },
      })
      expect(json.text()).not.toContain(ann.accessToken)
    })

    it("status --account asks about one account, even one that never signed in", async () => {
      const out = captureOut()
      await logtoCommand(parseArgv(["logto", "status", "--account", "lab", "--json"]), {
        home: HOME,
        out: out.sink,
        sessionFs: memFs({ [SESSION_FILE]: JSON.stringify(ann) }),
        env: {},
      })
      expect(JSON.parse(out.text())).toMatchObject({
        account: "lab",
        selected: true,
        selectedBy: "--account",
        state: "not-signed-in",
        person: null,
      })
    })

    it("logout keeps the binding, so the next sign-in as someone else is refused", async () => {
      const fs = memFs({
        [SESSION_FILE]: JSON.stringify(ann),
        [PERSON_FILE]: JSON.stringify(bound),
      })
      await logtoCommand(parseArgv(["logto", "logout"]), {
        home: HOME,
        out: captureOut().sink,
        sessionFs: fs,
        env: {},
        revoke: async () => ({ status: "revoked" as const }),
      })
      expect(fs.store.has(SESSION_FILE)).toBe(false)
      expect(fs.store.has(PERSON_FILE)).toBe(true)
      expect(await signIn(bob, fs).result).toBe(1)
    })
  })
})
