/**
 * @jest-environment node
 */
import { LogtoRefreshError, type LogtoSession } from "@/lib/logto/client"
import path from "node:path"

import {
  abandonLogtoLogin,
  beginLogtoLogin,
  cancelLogtoLogins,
  completeLogtoLogin,
  freshLogtoSessionFile,
  writeLogtoSessionFile,
  readLogtoSessionFile,
  readLogtoSessionSnapshot,
  removeLogtoSessionFile,
  removeLogtoSessionFileIf,
  logtoLoginAttemptPath,
  logtoSessionPath,
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
  }
}

const HOME = "/home/u/.cognia"
const session: LogtoSession = {
  issuer: "https://logto.test/oidc",
  clientId: "c",
  resource: "r",
  accessToken: "at",
  scopes: ["brain:rpc"],
}

describe("cli logto session file store", () => {
  it("stores at <home>/logto.json", () => {
    expect(logtoSessionPath(HOME)).toBe(path.join(HOME, "logto.json"))
  })

  it("writes the session as JSON, creating the home dir", () => {
    const fs = fakeFs()
    writeLogtoSessionFile(HOME, session, fs)
    expect(fs.dirs).toContain(HOME)
    expect(JSON.parse(fs.store.get(logtoSessionPath(HOME))!)).toEqual(session)
  })

  it("reads back a written session", () => {
    const fs = fakeFs()
    writeLogtoSessionFile(HOME, session, fs)
    expect(readLogtoSessionFile(HOME, fs)).toEqual(session)
  })

  it("returns null when the file is absent or corrupt", () => {
    const fs = fakeFs()
    expect(readLogtoSessionFile(HOME, fs)).toBeNull()
    fs.store.set(logtoSessionPath(HOME), "{not json")
    expect(readLogtoSessionFile(HOME, fs)).toBeNull()
  })

  it("removes the session file", () => {
    const fs = fakeFs()
    writeLogtoSessionFile(HOME, session, fs)
    removeLogtoSessionFile(HOME, fs)
    expect(fs.removed).toContain(logtoSessionPath(HOME))
    expect(readLogtoSessionFile(HOME, fs)).toBeNull()
  })
})

describe("freshLogtoSessionFile", () => {
  const home = "/home/u/.cognia"
  const stored = (expiresAt: number | undefined): LogtoSession =>
    ({
      issuer: "https://id.test/oidc",
      clientId: "cognia-app",
      resource: "https://api.test",
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt,
    }) as unknown as LogtoSession

  it("is null without a session and hands back one that is still good", async () => {
    const fs = fakeFs()
    expect(await freshLogtoSessionFile(home, { sessionFs: fs })).toBeNull()
    writeLogtoSessionFile(home, stored(10_000_000), fs)
    const refreshToken = jest.fn()
    const session = await freshLogtoSessionFile(home, { sessionFs: fs, refreshToken, now: () => 0 })
    expect(session?.accessToken).toBe("old")
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it("refreshes a session about to expire and writes it back", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, stored(30_000), fs)
    const refreshToken = jest.fn(async (_config: unknown, _refresh: string) => ({
      ...stored(9_000_000),
      accessToken: "new",
    }))
    const session = await freshLogtoSessionFile(home, { sessionFs: fs, refreshToken, now: () => 0 })
    expect(session?.accessToken).toBe("new")
    expect(refreshToken.mock.calls[0]![1]).toBe("refresh")
    expect(readLogtoSessionFile(home, fs)?.accessToken).toBe("new")
  })

  it("drops a refused login, and keeps the file through a passing failure", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, stored(30_000), fs)
    const offline = jest.fn(async () => {
      throw new LogtoRefreshError("network", "offline")
    })
    expect(
      await freshLogtoSessionFile(home, { sessionFs: fs, refreshToken: offline, now: () => 0 })
    ).toBeNull()
    expect(readLogtoSessionFile(home, fs)).not.toBeNull()
    const refused = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "revoked")
    })
    expect(
      await freshLogtoSessionFile(home, { sessionFs: fs, refreshToken: refused, now: () => 0 })
    ).toBeNull()
    expect(readLogtoSessionFile(home, fs)).toBeNull()
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

describe("concurrent writers of logto.json", () => {
  const home = "/home/u/.cognia"
  const person = (name: string, expiresAt: number): LogtoSession =>
    ({
      issuer: "https://id.test/oidc",
      clientId: "cognia-app",
      resource: "https://api.test",
      accessToken: `${name}-access`,
      refreshToken: `${name}-refresh`,
      expiresAt,
      scopes: [],
    }) as LogtoSession

  it("presents one refresh token once, however many callers want it refreshed", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, person("a", 30_000), fs)
    const used = new Set<string>()
    const refreshToken = jest.fn(async (_config: unknown, token: string) => {
      // A rotating issuer refuses the second use of a refresh token.
      if (used.has(token)) throw new LogtoRefreshError("invalid_grant", "reused")
      used.add(token)
      await settle()
      return person("a2", 9_000_000)
    })
    const deps = { sessionFs: fs, refreshToken, now: () => 0 }
    const [first, second] = await Promise.all([
      freshLogtoSessionFile(home, deps),
      freshLogtoSessionFile(home, deps),
    ])
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(first?.accessToken).toBe("a2-access")
    expect(second?.accessToken).toBe("a2-access")
    // The losing caller never got to delete the rotated session.
    expect(readLogtoSessionFile(home, fs)?.accessToken).toBe("a2-access")
  })

  it("a sign-in that finishes during a refresh is not overwritten by the refresh", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, person("a", 30_000), fs)
    const pending = deferred<LogtoSession>()
    const refreshing = freshLogtoSessionFile(home, {
      sessionFs: fs,
      refreshToken: () => pending.promise,
      now: () => 0,
    })
    await settle()
    const attempt = await Promise.race([beginLogtoLogin(home, fs), settle().then(() => null)])
    // The sign-in waits for the refresh to let go of the lock.
    expect(attempt).toBeNull()
    pending.resolve(person("a2", 9_000_000))
    await refreshing
    const saved = await completeLogtoLogin(
      home,
      await beginLogtoLogin(home, fs),
      person("b", 9_000_000),
      fs
    )
    expect(saved).toBe("saved")
    expect(readLogtoSessionFile(home, fs)?.accessToken).toBe("b-access")
  })

  it("a refresh that waited behind a sign-in hands out the new person's session untouched", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, person("a", 30_000), fs)
    // The sign-in holds the lock first; the refresh queued behind it must
    // decide on what the sign-in wrote, not on the session it first read.
    const attempt = await beginLogtoLogin(home, fs)
    const login = completeLogtoLogin(home, attempt, person("b", 9_000_000), fs)
    const refreshToken = jest.fn()
    const fresh = freshLogtoSessionFile(home, { sessionFs: fs, refreshToken, now: () => 0 })
    expect(await login).toBe("saved")
    expect((await fresh)?.accessToken).toBe("b-access")
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it("a refused refresh queued behind a sign-in does not delete the new session", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, person("a", 30_000), fs)
    const pending = deferred<LogtoSession>()
    const refreshing = freshLogtoSessionFile(home, {
      sessionFs: fs,
      refreshToken: () => pending.promise,
      now: () => 0,
    })
    await settle()
    const signIn = beginLogtoLogin(home, fs).then((attempt) =>
      completeLogtoLogin(home, attempt, person("b", 9_000_000), fs)
    )
    pending.reject(new LogtoRefreshError("invalid_grant", "revoked"))
    expect(await refreshing).toBeNull()
    expect(await signIn).toBe("saved")
    expect(readLogtoSessionFile(home, fs)?.accessToken).toBe("b-access")
  })

  it("a sign-out during a refresh is not undone by the refresh", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, person("a", 30_000), fs)
    const pending = deferred<LogtoSession>()
    const refreshing = freshLogtoSessionFile(home, {
      sessionFs: fs,
      refreshToken: () => pending.promise,
      now: () => 0,
    })
    await settle()
    const signOut = cancelLogtoLogins(home, fs).then(async () => {
      const snapshot = readLogtoSessionSnapshot(home, fs)
      return snapshot ? removeLogtoSessionFileIf(home, snapshot, fs) : false
    })
    pending.resolve(person("a2", 9_000_000))
    await refreshing
    expect(await signOut).toBe(true)
    expect(readLogtoSessionFile(home, fs)).toBeNull()
  })

  it("only the newest sign-in saves, whichever browser round trip finishes first", async () => {
    const fs = fakeFs()
    const ids = ["first", "second"]
    const first = await beginLogtoLogin(home, fs, () => ids.shift()!)
    const second = await beginLogtoLogin(home, fs, () => ids.shift()!)
    expect(await completeLogtoLogin(home, second, person("b", 9_000_000), fs)).toBe("saved")
    expect(await completeLogtoLogin(home, first, person("a", 9_000_000), fs)).toBe("superseded")
    expect(readLogtoSessionFile(home, fs)?.accessToken).toBe("b-access")
    expect(fs.store.has(logtoLoginAttemptPath(home))).toBe(false)
  })

  it("a sign-out supersedes a sign-in that started before it", async () => {
    const fs = fakeFs()
    const attempt = await beginLogtoLogin(home, fs)
    await cancelLogtoLogins(home, fs)
    expect(await completeLogtoLogin(home, attempt, person("a", 9_000_000), fs)).toBe("superseded")
    expect(readLogtoSessionFile(home, fs)).toBeNull()
  })

  it("an abandoned sign-in withdraws only its own marker", async () => {
    const fs = fakeFs()
    const ids = ["old", "new"]
    const old = await beginLogtoLogin(home, fs, () => ids.shift()!)
    const latest = await beginLogtoLogin(home, fs, () => ids.shift()!)
    await abandonLogtoLogin(home, old, fs)
    expect(await completeLogtoLogin(home, latest, person("b", 9_000_000), fs)).toBe("saved")
  })

  it("removes the session only while it is still the one read", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, person("a", 9_000_000), fs)
    const snapshot = readLogtoSessionSnapshot(home, fs)!
    writeLogtoSessionFile(home, person("b", 9_000_000), fs)
    expect(await removeLogtoSessionFileIf(home, snapshot, fs)).toBe(false)
    expect(readLogtoSessionFile(home, fs)?.accessToken).toBe("b-access")
    expect(await removeLogtoSessionFileIf(home, readLogtoSessionSnapshot(home, fs)!, fs)).toBe(true)
    expect(readLogtoSessionFile(home, fs)).toBeNull()
  })

  it("the real store serializes through the CLI file lock across processes", async () => {
    const os = await import("node:os")
    const nodeFs = await import("node:fs")
    const { realLogtoSessionFs } = await import("./logto-session")
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "logto-lock-"))
    try {
      writeLogtoSessionFile(dir, person("a", 30_000))
      const refreshToken = jest.fn(async () => {
        await settle()
        return person("a2", 9_000_000)
      })
      const deps = { sessionFs: realLogtoSessionFs, refreshToken, now: () => 0 }
      await Promise.all([freshLogtoSessionFile(dir, deps), freshLogtoSessionFile(dir, deps)])
      expect(refreshToken).toHaveBeenCalledTimes(1)
      expect(nodeFs.existsSync(path.join(dir, "auth", "locks"))).toBe(true)
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
