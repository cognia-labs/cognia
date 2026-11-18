/**
 * @jest-environment node
 */
import { LogtoRefreshError, type LogtoSession } from "@/lib/logto/client"
import path from "node:path"

import { accountSignInDir } from "./local-account"
import {
  abandonLogtoLogin,
  beginLogtoLogin,
  cancelLogtoLogins,
  completeLogtoLogin,
  describePerson,
  freshLogtoSessionFile,
  listAccountSignIns,
  logtoBoundPersonPath,
  logtoLoginAttemptPath,
  logtoLoginInFlight,
  logtoSessionPath,
  personOfSession,
  readBoundPerson,
  readLogtoSessionFile,
  readLogtoSessionSnapshot,
  removeLogtoSessionFile,
  removeLogtoSessionFileIf,
  samePerson,
  writeLogtoSessionFile,
  type LogtoSessionFs,
} from "./logto-session"

function fakeFs(): LogtoSessionFs & {
  store: Map<string, string>
  removed: string[]
  dirs: string[]
} {
  const store = new Map<string, string>()
  const removed: string[] = []
  const dirs: string[] = []
  return {
    store,
    removed,
    dirs,
    read: (p) => store.get(p) ?? null,
    write: (p, c) => {
      store.set(p, c)
    },
    remove: (p) => {
      store.delete(p)
      removed.push(p)
    },
    mkdirp: (d) => {
      dirs.push(d)
    },
    listDirs: (d) => {
      const prefix = `${d}${path.sep}`
      const names = new Set<string>()
      for (const key of [...store.keys(), ...dirs]) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length).split(path.sep)
        if (rest.length > 1 || dirs.includes(key)) names.add(rest[0]!)
      }
      return [...names]
    },
  }
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
/** An unsigned JWT: the store only ever reads claims, it never verifies. */
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "none" })}.${b64(claims)}.sig`

const HOME = "/home/u/.cognia"
const DIR = accountSignInDir(HOME, "local_acct_a")
const OTHER = accountSignInDir(HOME, "work")
const ISSUER = "https://id.test/oidc"

/** A session for `name` (whose subject is `usr_<name>`), expiring at `expiresAt`. */
const person = (name: string, expiresAt = 9_000_000, issuer = ISSUER): LogtoSession =>
  ({
    issuer,
    clientId: "cognia-app",
    resource: "https://api.test",
    accessToken: jwt({ sub: `usr_${name.replace(/\d+$/, "")}`, tag: name }),
    idToken: jwt({ name: `Person ${name}`, email: `${name}@example.com` }),
    refreshToken: `${name}-refresh`,
    expiresAt,
    scopes: [],
  }) as LogtoSession

const tagOf = (session: LogtoSession | null) =>
  session
    ? (
        JSON.parse(Buffer.from(session.accessToken.split(".")[1]!, "base64url").toString()) as {
          tag: string
        }
      ).tag
    : null

describe("cli logto session file store", () => {
  it("keeps each account's files in its own directory", () => {
    expect(logtoSessionPath(DIR)).toBe(path.join(HOME, "accounts", "local_acct_a", "logto.json"))
    expect(logtoLoginAttemptPath(DIR)).toBe(
      path.join(HOME, "accounts", "local_acct_a", "logto-login.json")
    )
    expect(logtoBoundPersonPath(DIR)).toBe(
      path.join(HOME, "accounts", "local_acct_a", "person.json")
    )
  })

  it("writes the session as JSON, creating the account dir", () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a"), fs)
    expect(fs.dirs).toContain(DIR)
    expect(JSON.parse(fs.store.get(logtoSessionPath(DIR))!)).toEqual(person("a"))
  })

  it("reads back a written session, and two accounts never see each other's", () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a"), fs)
    expect(readLogtoSessionFile(DIR, fs)).toEqual(person("a"))
    expect(readLogtoSessionFile(OTHER, fs)).toBeNull()
  })

  it("returns null when the file is absent or corrupt", () => {
    const fs = fakeFs()
    expect(readLogtoSessionFile(DIR, fs)).toBeNull()
    fs.store.set(logtoSessionPath(DIR), "{not json")
    expect(readLogtoSessionFile(DIR, fs)).toBeNull()
  })

  it("removes the session file", () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a"), fs)
    removeLogtoSessionFile(DIR, fs)
    expect(fs.removed).toContain(logtoSessionPath(DIR))
    expect(readLogtoSessionFile(DIR, fs)).toBeNull()
  })
})

describe("the bound person", () => {
  it("reads the person from the access token's subject and the ID token's profile", () => {
    expect(personOfSession(person("ann"), 5)).toEqual({
      issuer: ISSUER,
      subject: "usr_ann",
      userId: "usr_ann",
      displayName: "Person ann",
      email: "ann@example.com",
      boundAt: 5,
    })
    expect(personOfSession({ ...person("ann"), accessToken: "opaque" }, 5)).toBeNull()
  })

  it("keeps a self-hosted subject without calling it a Cognia person id", () => {
    const session = { ...person("x"), accessToken: jwt({ sub: "logto-123", organization_id: "o" }) }
    expect(personOfSession(session, 1)).toMatchObject({
      subject: "logto-123",
      organizationId: "o",
    })
    expect(personOfSession(session, 1)?.userId).toBeUndefined()
  })

  it("is the same person only at the same issuer", () => {
    const ann = { issuer: ISSUER, subject: "usr_ann" }
    expect(samePerson(ann, { issuer: `${ISSUER}/`, subject: "usr_ann" })).toBe(true)
    expect(samePerson(ann, { issuer: "https://staging.test/oidc", subject: "usr_ann" })).toBe(false)
    expect(samePerson(ann, { issuer: ISSUER, subject: "usr_bob" })).toBe(false)
  })

  it("describes a person with what is known of them", () => {
    expect(describePerson({ subject: "usr_a", displayName: "Ann", email: "a@x" })).toBe(
      "Ann <a@x> (usr_a)"
    )
    expect(describePerson({ subject: "usr_a", email: "a@x" })).toBe("a@x (usr_a)")
    expect(describePerson({ subject: "usr_a" })).toBe("usr_a")
  })

  it("refuses to read a binding file it cannot parse rather than calling the account unbound", () => {
    const fs = fakeFs()
    expect(readBoundPerson(DIR, fs)).toBeNull()
    fs.store.set(logtoBoundPersonPath(DIR), '{"issuer":"x"}')
    expect(() => readBoundPerson(DIR, fs)).toThrow(/not a readable binding/)
  })
})

describe("binding on sign-in", () => {
  const signIn = async (
    fs: LogtoSessionFs,
    session: LogtoSession,
    options: { rebind?: boolean } = {},
    dir = DIR
  ) =>
    completeLogtoLogin(dir, await beginLogtoLogin(dir, fs), session, fs, {
      now: () => 7,
      ...options,
    })

  it("binds the account to whoever signs in first", async () => {
    const fs = fakeFs()
    const result = await signIn(fs, person("ann"))
    expect(result).toMatchObject({
      kind: "saved",
      binding: "bound",
      person: { subject: "usr_ann" },
    })
    expect(readBoundPerson(DIR, fs)).toMatchObject({ subject: "usr_ann", boundAt: 7 })
    expect(fs.store.has(logtoLoginAttemptPath(DIR))).toBe(false)
  })

  it("lets the bound person sign in again and keeps when they first bound", async () => {
    const fs = fakeFs()
    await signIn(fs, person("ann"))
    const again = await completeLogtoLogin(
      DIR,
      await beginLogtoLogin(DIR, fs),
      person("ann2"),
      fs,
      {
        now: () => 99,
      }
    )
    expect(again).toMatchObject({ kind: "saved", binding: "same" })
    expect(tagOf(readLogtoSessionFile(DIR, fs))).toBe("ann2")
    expect(readBoundPerson(DIR, fs)?.boundAt).toBe(7)
  })

  it("refuses someone else, keeping the bound person's session and binding", async () => {
    const fs = fakeFs()
    await signIn(fs, person("ann"))
    const result = await signIn(fs, person("bob"))
    expect(result).toMatchObject({
      kind: "mismatch",
      bound: { subject: "usr_ann" },
      incoming: { subject: "usr_bob" },
    })
    expect(tagOf(readLogtoSessionFile(DIR, fs))).toBe("ann")
    expect(readBoundPerson(DIR, fs)?.subject).toBe("usr_ann")
    expect(fs.store.has(logtoLoginAttemptPath(DIR))).toBe(false)
  })

  it("refuses the same subject at another issuer: that is another person", async () => {
    const fs = fakeFs()
    await signIn(fs, person("ann"))
    const staging = await signIn(fs, person("ann", 9_000_000, "https://staging.test/oidc"))
    expect(staging.kind).toBe("mismatch")
  })

  it("rebinds only when asked, and reports whom the account acted for before", async () => {
    const fs = fakeFs()
    await signIn(fs, person("ann"))
    const result = await signIn(fs, person("bob"), { rebind: true })
    expect(result).toMatchObject({
      kind: "saved",
      binding: "rebound",
      person: { subject: "usr_bob" },
      previous: { subject: "usr_ann" },
    })
    expect(readBoundPerson(DIR, fs)?.subject).toBe("usr_bob")
    expect(tagOf(readLogtoSessionFile(DIR, fs))).toBe("bob")
  })

  it("binds nobody to a token that names nobody", async () => {
    const fs = fakeFs()
    const result = await signIn(fs, { ...person("ann"), accessToken: "opaque" })
    expect(result).toEqual({ kind: "no-person" })
    expect(readLogtoSessionFile(DIR, fs)).toBeNull()
    expect(readBoundPerson(DIR, fs)).toBeNull()
  })

  it("keeps the binding when the account signs out", async () => {
    const fs = fakeFs()
    await signIn(fs, person("ann"))
    await removeLogtoSessionFileIf(DIR, readLogtoSessionSnapshot(DIR, fs)!, fs)
    expect(readLogtoSessionFile(DIR, fs)).toBeNull()
    expect(readBoundPerson(DIR, fs)?.subject).toBe("usr_ann")
    expect((await signIn(fs, person("bob"))).kind).toBe("mismatch")
  })

  it("binds each account on its own", async () => {
    const fs = fakeFs()
    await signIn(fs, person("ann"))
    expect(await signIn(fs, person("bob"), {}, OTHER)).toMatchObject({ binding: "bound" })
    expect(readBoundPerson(DIR, fs)?.subject).toBe("usr_ann")
    expect(readBoundPerson(OTHER, fs)?.subject).toBe("usr_bob")
  })
})

describe("listAccountSignIns", () => {
  it("lists every account directory with its session, binding and sign-in in flight", async () => {
    const fs = fakeFs()
    await completeLogtoLogin(DIR, await beginLogtoLogin(DIR, fs), person("ann"), fs)
    await beginLogtoLogin(OTHER, fs)
    fs.mkdirp(path.join(HOME, "accounts", "%zz"))
    const entries = listAccountSignIns(HOME, fs)
    expect(entries.map((e) => e.accountId)).toEqual(["local_acct_a", "work"])
    expect(entries[0]).toMatchObject({
      session: expect.any(Object),
      person: { subject: "usr_ann" },
      loginInFlight: false,
    })
    expect(entries[1]).toMatchObject({ session: null, person: null, loginInFlight: true })
    expect(logtoLoginInFlight(OTHER, fs)).toBe(true)
  })

  it("reports an unreadable binding instead of hiding the account", () => {
    const fs = fakeFs()
    fs.store.set(logtoBoundPersonPath(DIR), "garbage")
    const [entry] = listAccountSignIns(HOME, fs)
    expect(entry).toMatchObject({ accountId: "local_acct_a", person: null })
    expect(entry!.personError).toMatch(/not a readable binding/)
  })
})

describe("freshLogtoSessionFile", () => {
  it("is null without a session and hands back one that is still good", async () => {
    const fs = fakeFs()
    expect(await freshLogtoSessionFile(DIR, { sessionFs: fs })).toBeNull()
    writeLogtoSessionFile(DIR, person("a", 10_000_000), fs)
    const refreshToken = jest.fn()
    const session = await freshLogtoSessionFile(DIR, { sessionFs: fs, refreshToken, now: () => 0 })
    expect(tagOf(session)).toBe("a")
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it("refreshes a session about to expire and writes it back", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a", 30_000), fs)
    const refreshToken = jest.fn(async (_config: unknown, _refresh: string) => person("a2"))
    const session = await freshLogtoSessionFile(DIR, { sessionFs: fs, refreshToken, now: () => 0 })
    expect(tagOf(session)).toBe("a2")
    expect(refreshToken.mock.calls[0]![1]).toBe("a-refresh")
    expect(tagOf(readLogtoSessionFile(DIR, fs))).toBe("a2")
  })

  it("drops a refused login, and keeps the file through a passing failure", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a", 30_000), fs)
    const offline = jest.fn(async () => {
      throw new LogtoRefreshError("network", "offline")
    })
    expect(
      await freshLogtoSessionFile(DIR, { sessionFs: fs, refreshToken: offline, now: () => 0 })
    ).toBeNull()
    expect(readLogtoSessionFile(DIR, fs)).not.toBeNull()
    const refused = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "revoked")
    })
    expect(
      await freshLogtoSessionFile(DIR, { sessionFs: fs, refreshToken: refused, now: () => 0 })
    ).toBeNull()
    expect(readLogtoSessionFile(DIR, fs)).toBeNull()
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets queued microtasks and lock hand-offs run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("concurrent writers of an account's sign-in", () => {
  it("presents one refresh token once, however many callers want it refreshed", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a", 30_000), fs)
    const used = new Set<string>()
    const refreshToken = jest.fn(async (_config: unknown, token: string) => {
      // A rotating issuer refuses the second use of a refresh token.
      if (used.has(token)) throw new LogtoRefreshError("invalid_grant", "reused")
      used.add(token)
      await settle()
      return person("a2")
    })
    const deps = { sessionFs: fs, refreshToken, now: () => 0 }
    const [first, second] = await Promise.all([
      freshLogtoSessionFile(DIR, deps),
      freshLogtoSessionFile(DIR, deps),
    ])
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(tagOf(first)).toBe("a2")
    expect(tagOf(second)).toBe("a2")
    // The losing caller never got to delete the rotated session.
    expect(tagOf(readLogtoSessionFile(DIR, fs))).toBe("a2")
  })

  it("a sign-in that finishes during a refresh is not overwritten by the refresh", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a", 30_000), fs)
    const pending = deferred<LogtoSession>()
    const refreshing = freshLogtoSessionFile(DIR, {
      sessionFs: fs,
      refreshToken: () => pending.promise,
      now: () => 0,
    })
    await settle()
    const attempt = await Promise.race([beginLogtoLogin(DIR, fs), settle().then(() => null)])
    // The sign-in waits for the refresh to let go of the lock.
    expect(attempt).toBeNull()
    pending.resolve(person("a2"))
    await refreshing
    const saved = await completeLogtoLogin(DIR, await beginLogtoLogin(DIR, fs), person("a3"), fs)
    expect(saved.kind).toBe("saved")
    expect(tagOf(readLogtoSessionFile(DIR, fs))).toBe("a3")
  })

  it("a refresh that waited behind a sign-in hands out the new session untouched", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a", 30_000), fs)
    // The sign-in holds the lock first; the refresh queued behind it must
    // decide on what the sign-in wrote, not on the session it first read.
    const attempt = await beginLogtoLogin(DIR, fs)
    const login = completeLogtoLogin(DIR, attempt, person("a2"), fs)
    const refreshToken = jest.fn()
    const fresh = freshLogtoSessionFile(DIR, { sessionFs: fs, refreshToken, now: () => 0 })
    expect((await login).kind).toBe("saved")
    expect(tagOf(await fresh)).toBe("a2")
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it("a refused refresh queued behind a sign-in does not delete the new session", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a", 30_000), fs)
    const pending = deferred<LogtoSession>()
    const refreshing = freshLogtoSessionFile(DIR, {
      sessionFs: fs,
      refreshToken: () => pending.promise,
      now: () => 0,
    })
    await settle()
    const signIn = beginLogtoLogin(DIR, fs).then((attempt) =>
      completeLogtoLogin(DIR, attempt, person("a2"), fs)
    )
    pending.reject(new LogtoRefreshError("invalid_grant", "revoked"))
    expect(await refreshing).toBeNull()
    expect((await signIn).kind).toBe("saved")
    expect(tagOf(readLogtoSessionFile(DIR, fs))).toBe("a2")
  })

  it("a sign-out during a refresh is not undone by the refresh", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a", 30_000), fs)
    const pending = deferred<LogtoSession>()
    const refreshing = freshLogtoSessionFile(DIR, {
      sessionFs: fs,
      refreshToken: () => pending.promise,
      now: () => 0,
    })
    await settle()
    const signOut = cancelLogtoLogins(DIR, fs).then(async () => {
      const snapshot = readLogtoSessionSnapshot(DIR, fs)
      return snapshot ? removeLogtoSessionFileIf(DIR, snapshot, fs) : false
    })
    pending.resolve(person("a2"))
    await refreshing
    expect(await signOut).toBe(true)
    expect(readLogtoSessionFile(DIR, fs)).toBeNull()
  })

  it("only the newest sign-in saves, whichever browser round trip finishes first", async () => {
    const fs = fakeFs()
    const ids = ["first", "second"]
    const first = await beginLogtoLogin(DIR, fs, () => ids.shift()!)
    const second = await beginLogtoLogin(DIR, fs, () => ids.shift()!)
    expect((await completeLogtoLogin(DIR, second, person("b"), fs)).kind).toBe("saved")
    expect(await completeLogtoLogin(DIR, first, person("a"), fs)).toEqual({ kind: "superseded" })
    expect(tagOf(readLogtoSessionFile(DIR, fs))).toBe("b")
    expect(fs.store.has(logtoLoginAttemptPath(DIR))).toBe(false)
  })

  it("a sign-in to one account does not supersede a sign-in to another", async () => {
    const fs = fakeFs()
    const mine = await beginLogtoLogin(DIR, fs)
    await beginLogtoLogin(OTHER, fs)
    expect((await completeLogtoLogin(DIR, mine, person("a"), fs)).kind).toBe("saved")
  })

  it("a sign-out supersedes a sign-in that started before it", async () => {
    const fs = fakeFs()
    const attempt = await beginLogtoLogin(DIR, fs)
    await cancelLogtoLogins(DIR, fs)
    expect(await completeLogtoLogin(DIR, attempt, person("a"), fs)).toEqual({ kind: "superseded" })
    expect(readLogtoSessionFile(DIR, fs)).toBeNull()
  })

  it("an abandoned sign-in withdraws only its own marker", async () => {
    const fs = fakeFs()
    const ids = ["old", "new"]
    const old = await beginLogtoLogin(DIR, fs, () => ids.shift()!)
    const latest = await beginLogtoLogin(DIR, fs, () => ids.shift()!)
    await abandonLogtoLogin(DIR, old, fs)
    expect((await completeLogtoLogin(DIR, latest, person("b"), fs)).kind).toBe("saved")
  })

  it("removes the session only while it is still the one read", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(DIR, person("a"), fs)
    const snapshot = readLogtoSessionSnapshot(DIR, fs)!
    writeLogtoSessionFile(DIR, person("b"), fs)
    expect(await removeLogtoSessionFileIf(DIR, snapshot, fs)).toBe(false)
    expect(tagOf(readLogtoSessionFile(DIR, fs))).toBe("b")
    expect(await removeLogtoSessionFileIf(DIR, readLogtoSessionSnapshot(DIR, fs)!, fs)).toBe(true)
    expect(readLogtoSessionFile(DIR, fs)).toBeNull()
  })

  it("the real store locks each account in its own directory across processes", async () => {
    const os = await import("node:os")
    const nodeFs = await import("node:fs")
    const { realLogtoSessionFs } = await import("./logto-session")
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "logto-lock-"))
    try {
      const dir = accountSignInDir(home, "local_acct_a")
      writeLogtoSessionFile(dir, person("a", 30_000))
      const refreshToken = jest.fn(async () => {
        await settle()
        return person("a2")
      })
      const deps = { sessionFs: realLogtoSessionFs, refreshToken, now: () => 0 }
      await Promise.all([freshLogtoSessionFile(dir, deps), freshLogtoSessionFile(dir, deps)])
      expect(refreshToken).toHaveBeenCalledTimes(1)
      expect(nodeFs.existsSync(path.join(dir, "auth", "locks"))).toBe(true)
      expect(listAccountSignIns(home).map((entry) => entry.accountId)).toEqual(["local_acct_a"])
      expect((nodeFs.statSync(dir).mode & 0o777).toString(8)).toBe("700")
    } finally {
      nodeFs.rmSync(home, { recursive: true, force: true })
    }
  })
})
