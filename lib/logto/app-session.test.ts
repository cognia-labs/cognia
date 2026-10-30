const platformFetch = jest.fn()
import "fake-indexeddb/auto"
jest.mock("@/lib/network/platform-fetch", () => ({
  createPlatformFetch: () => platformFetch,
}))

import {
  getActiveLogtoSession,
  readActiveAccessToken,
  resolveLogtoSession,
  REFRESH_SKEW_MS,
  signInToLogto,
  signOutFromLogto,
  signOutLeftTokensLive,
  updateLogtoSession,
  type LogtoAppSessionDeps,
  type LogtoAuthCommitContext,
  type LogtoSignOutReport,
} from "./app-session"
import { LogtoRefreshError, type LogtoSession } from "./client"

const NOW = 1_000_000

function session(over: Partial<LogtoSession> = {}): LogtoSession {
  return {
    issuer: "https://logto.test/oidc",
    clientId: "app_1",
    resource: "https://api.test",
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: NOW + 3_600_000,
    scopes: ["openid", "brain:rpc"],
    ...over,
  }
}

const drivers = { openUrl: jest.fn(), waitForCode: jest.fn() }
const config = {
  issuer: "https://logto.test/oidc",
  clientId: "app_1",
  redirectUri: "https://cb",
  resource: "https://api.test",
}

/** Every keyring effect stubbed, with the marker stubs defaulting to "none". */
function base(over: Partial<LogtoAppSessionDeps>): LogtoAppSessionDeps {
  return {
    now: () => NOW,
    loadReauth: jest.fn(async () => null),
    markReauth: jest.fn(async () => {}),
    clearReauth: jest.fn(async () => {}),
    save: jest.fn(async () => {}),
    locks: null,
    ...over,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function memorySession(initial: LogtoSession | null, localAccountId: string) {
  let current = initial
  const deps = base({
    localAccountId,
    load: async () => current,
    save: async (value) => {
      current = value
    },
    clear: async () => {
      current = null
    },
    discover: async () => {
      throw new Error("issuer unavailable")
    },
    revoke: async () => ({ status: "failed", reason: "issuer unavailable" }),
  })
  return { deps, current: () => current }
}

describe("signInToLogto", () => {
  it("runs the flow and persists the resulting session for the named profile", async () => {
    const s = session()
    const login = jest.fn(async () => s)
    const save = jest.fn(async () => {})
    const result = await signInToLogto(config, drivers, { login, save, localAccountId: "acct_a" })
    expect(login).toHaveBeenCalledWith(config, drivers)
    expect(save).toHaveBeenCalledWith(s, "acct_a")
    expect(result).toBe(s)
  })

  it("never persists a candidate rejected by the profile ownership check", async () => {
    const save = jest.fn(async () => {})
    const beforeCommit = jest.fn(async () => {
      throw new Error("already bound")
    })
    await expect(
      signInToLogto(config, drivers, {
        localAccountId: "acct_rejected_candidate",
        login: async () => session({ accessToken: "bob" }),
        save,
        beforeCommit,
      })
    ).rejects.toThrow("already bound")
    expect(beforeCommit).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })

  it("publishes identity only after token persistence and leaves it untouched on storage failure", async () => {
    const order: string[] = []
    const afterCommit = jest.fn(async () => {
      order.push("identity")
    })
    await signInToLogto(config, drivers, {
      localAccountId: "acct_after_commit_order",
      login: async () => session(),
      beforeCommit: async () => {
        order.push("validate")
      },
      save: async () => {
        order.push("session")
      },
      afterCommit,
    })
    expect(order).toEqual(["validate", "session", "identity"])
    afterCommit.mockClear()
    await expect(
      signInToLogto(config, drivers, {
        localAccountId: "acct_after_commit_failure",
        login: async () => session(),
        save: async () => {
          throw new Error("credential storage unavailable")
        },
        afterCommit,
      })
    ).rejects.toThrow("credential storage unavailable")
    expect(afterCommit).not.toHaveBeenCalled()
  })

  it("provides a callback guard limited to the successful commit without inventing a native revision for injected storage", async () => {
    let context!: LogtoAuthCommitContext
    await signInToLogto(config, drivers, {
      localAccountId: "acct_commit_context",
      login: async () => session(),
      save: async () => {},
      afterCommit: async (_candidate, current) => {
        context = current
        expect(() => context.assertCurrent()).not.toThrow()
        expect(context.authRevision).toBeUndefined()
      },
    })
    expect(() => context.assertCurrent()).toThrow("authentication lock")
  })

  it("does not restore a pending interactive login after logout", async () => {
    const state = memorySession(session(), "acct_pending_login_logout")
    const response = deferred<LogtoSession>()
    const started = deferred<void>()
    const loggingIn = signInToLogto(config, drivers, {
      ...state.deps,
      login: async () => {
        started.resolve()
        return response.promise
      },
    })
    const rejected = expect(loggingIn).rejects.toThrow("superseded")
    await started.promise
    await signOutFromLogto(state.deps)
    response.resolve(session({ accessToken: "late-login" }))
    await rejected
    expect(state.current()).toBeNull()
  })

  it("keeps a newer interactive login when an older one finishes last", async () => {
    const state = memorySession(null, "acct_login_order")
    const older = deferred<LogtoSession>()
    const started = deferred<void>()
    const oldLogin = signInToLogto(config, drivers, {
      ...state.deps,
      login: async () => {
        started.resolve()
        return older.promise
      },
    })
    const rejected = expect(oldLogin).rejects.toThrow("superseded")
    await started.promise
    const newer = session({ accessToken: "newer-login" })
    await signInToLogto(config, drivers, { ...state.deps, login: async () => newer })
    older.resolve(session({ accessToken: "older-login" }))
    await rejected
    expect(state.current()).toBe(newer)
  })
})

describe("auth mutation fencing", () => {
  it("preserves a rotated existing session when a concurrent different-person login is rejected", async () => {
    const state = memorySession(
      session({ expiresAt: NOW - 1 }),
      "acct_rejected_login_during_refresh"
    )
    const response = deferred<LogtoSession>()
    const started = deferred<void>()
    const refreshing = resolveLogtoSession({
      ...state.deps,
      refresh: async () => {
        started.resolve()
        return response.promise
      },
    })
    await started.promise
    await expect(
      signInToLogto(config, drivers, {
        ...state.deps,
        login: async () => session({ accessToken: "bob" }),
        beforeCommit: async () => {
          throw new Error("already bound to Alice")
        },
      })
    ).rejects.toThrow("already bound to Alice")
    const rotated = session({ accessToken: "alice-rotated", refreshToken: "alice-next-refresh" })
    response.resolve(rotated)
    expect(await refreshing).toEqual({ status: "active", session: rotated })
    expect(state.current()).toBe(rotated)
  })

  it("serializes auth commits in two module realms without Web Locks", async () => {
    let first!: typeof import("./app-session")
    let second!: typeof import("./app-session")
    await jest.isolateModulesAsync(async () => {
      first = await import("./app-session")
    })
    await jest.isolateModulesAsync(async () => {
      second = await import("./app-session")
    })
    const original = session()
    let current: LogtoSession | null = original
    let revision: string | null = null
    const entered = deferred<void>()
    const release = deferred<void>()
    const order: string[] = []
    const deps = base({
      localAccountId: "acct_two_realms_no_web_locks",
      load: async () => current,
      save: async (value) => {
        order.push("update-persist")
        current = value
      },
      clear: async () => {
        order.push("logout-clear")
        current = null
      },
      loadRevision: async () => revision,
      saveRevision: async (value) => {
        revision = value
      },
      discover: async () => {
        throw new Error("issuer unavailable")
      },
      revoke: async () => ({ status: "failed", reason: "issuer unavailable" }),
    })
    const updating = first.updateLogtoSession(
      original,
      async () => session({ accessToken: "org-updated" }),
      {
        ...deps,
        beforeCommit: async () => {
          entered.resolve()
          await release.promise
        },
      }
    )
    await entered.promise
    const loggingOut = second.signOutFromLogto(deps)
    await new Promise((resolve) => setTimeout(resolve, 0))
    release.resolve()
    await Promise.all([updating, loggingOut])
    expect(order).toEqual(["update-persist", "logout-clear"])
    expect(current).toBeNull()
  })

  it.each(["session", "attempt"] as const)(
    "rejects a delayed native %s commit after its fallback mutex aborts and another realm logs out",
    async (delayed) => {
      const profile = "acct_native_interrupted_commit"
      const original = session()
      const values = new Map<string, string>([[`session:${profile}`, JSON.stringify(original)]])
      const issued = deferred<void>()
      const release = deferred<void>()
      const finished = deferred<void>()
      const ipc = jest.fn(
        async (
          name: string,
          payload: {
            input: { key: string; value?: string }
            condition?: {
              expected: string | null
              changes: { key: string; value: string | null }[]
            }
          }
        ) => {
          const { input, condition } = payload
          if (name === "secret_store_get") return values.get(input.key) ?? null
          if (name === "secret_store_delete") {
            values.delete(input.key)
            return
          }
          if (name !== "secret_store_set") throw new Error(`Unexpected command ${name}`)
          const writesSession =
            input.key === `session:${profile}` ||
            condition?.changes.some(
              (change) => change.key === `session:${profile}` && change.value !== null
            )
          const delayThisWrite =
            delayed === "session"
              ? writesSession
              : input.key === `auth-revision:${profile}` && !condition?.changes.length
          if (delayThisWrite) {
            issued.resolve()
            await release.promise
          }
          try {
            // Match the native contract: compare AND publish under one storage lock,
            // after an issued command eventually reaches its blocking worker.
            if (condition && (values.get(input.key) ?? null) !== condition.expected)
              throw new Error("secret-store condition mismatch")
            values.set(input.key, input.value!)
            for (const change of condition?.changes ?? []) {
              if (change.value === null) values.delete(change.key)
              else values.set(change.key, change.value)
            }
          } finally {
            if (delayThisWrite) finished.resolve()
          }
        }
      )
      jest.doMock("@/lib/tauri", () => ({ isTauri: () => true, isCapacitor: () => false }))
      jest.doMock("@tauri-apps/api/core", () => ({ invoke: ipc }))
      const transaction = IDBDatabase.prototype.transaction
      let activeAuth!: IDBTransaction
      const transactionSpy = jest
        .spyOn(IDBDatabase.prototype, "transaction")
        .mockImplementation(function (
          this: IDBDatabase,
          ...args: Parameters<IDBDatabase["transaction"]>
        ) {
          const result = transaction.apply(this, args)
          if (args[0] === "auth") activeAuth = result
          return result
        })
      try {
        let first!: typeof import("./app-session")
        let second!: typeof import("./app-session")
        await jest.isolateModulesAsync(async () => {
          first = await import("./app-session")
        })
        await jest.isolateModulesAsync(async () => {
          second = await import("./app-session")
        })
        const deps = {
          localAccountId: profile,
          locks: null,
          discover: async () => {
            throw new Error("issuer unavailable")
          },
        }
        const updating =
          delayed === "session"
            ? first.updateLogtoSession(
                original,
                async () => session({ accessToken: "late-native" }),
                deps
              )
            : first.signInToLogto(config, drivers, {
                ...deps,
                login: async () => session({ accessToken: "late-native" }),
              })
        const rejected = expect(updating).rejects.toThrow("authentication lock")
        await issued.promise
        activeAuth.abort()
        await rejected
        const loggedOut = await second.signOutFromLogto(deps, { revoke: false })
        expect(loggedOut.cleared).toBe(true)
        const logoutRevision = values.get(`auth-revision:${profile}`)
        release.resolve()
        await finished.promise
        expect(values.has(`session:${profile}`)).toBe(false)
        expect(values.get(`auth-revision:${profile}`)).toBe(logoutRevision)
      } finally {
        release.resolve()
        transactionSpy.mockRestore()
        jest.dontMock("@/lib/tauri")
        jest.dontMock("@tauri-apps/api/core")
      }
    }
  )

  it("rejects a stale refresh when another window changes the durable revision without changing the old token", async () => {
    const stale = session({ expiresAt: NOW - 1 })
    const state = memorySession(stale, "acct_durable_revision")
    let revision = "revision-original"
    const response = deferred<LogtoSession>()
    const started = deferred<void>()
    const refreshing = resolveLogtoSession({
      ...state.deps,
      loadRevision: async () => revision,
      saveRevision: async (next) => {
        revision = next
      },
      refresh: async () => {
        started.resolve()
        return response.promise
      },
    })
    await started.promise
    // Another window invalidated auth but its native delete failed, leaving the old blob.
    revision = "revision-from-another-window"
    response.resolve(session({ accessToken: "must-not-commit" }))
    expect(await refreshing).toMatchObject({
      status: "error",
      reason: "Authentication changed while refreshing.",
    })
    expect(state.current()).toBe(stale)
  })

  it("uses the same cross-tab auth commit lock for sign-in and sign-out", async () => {
    const state = memorySession(null, "acct_commit_locks")
    const request = jest.fn((_name: string, task: () => Promise<unknown>) => task())
    const deps = { ...state.deps, locks: { request } as never }
    await signInToLogto(config, drivers, { ...deps, login: async () => session() })
    await signOutFromLogto(deps)
    expect(request.mock.calls.map(([name]) => name)).toEqual([
      "cognia-logto-auth:acct_commit_locks",
      "cognia-logto-auth:acct_commit_locks",
      "cognia-logto-auth:acct_commit_locks",
    ])
  })

  it("does not open an issuer login when its durable operation fence cannot be saved", async () => {
    const state = memorySession(session(), "acct_revision_write_failure")
    const login = jest.fn(async () => session({ accessToken: "candidate" }))
    await expect(
      signInToLogto(config, drivers, {
        ...state.deps,
        login,
        saveRevision: async () => {
          throw new Error("revision storage unavailable")
        },
      })
    ).rejects.toThrow("revision storage unavailable")
    expect(login).not.toHaveBeenCalled()
    expect(state.current()?.accessToken).toBe("at")
  })

  it("rejects an old organization-token update after logout instead of restoring it", async () => {
    const original = session()
    const state = memorySession(original, "acct_org_update_logout")
    const response = deferred<LogtoSession>()
    const started = deferred<void>()
    const beforeCommit = jest.fn(async () => {})
    const updating = updateLogtoSession(
      original,
      async () => {
        started.resolve()
        return response.promise
      },
      { ...state.deps, beforeCommit }
    )
    const rejected = expect(updating).rejects.toThrow("superseded")
    await started.promise
    await signOutFromLogto(state.deps)
    response.resolve(session({ organizationId: "org_late" }))
    await rejected
    expect(state.current()).toBeNull()
    expect(beforeCommit).not.toHaveBeenCalled()
  })

  it("does not contact the issuer for an update whose previous session is already obsolete", async () => {
    const state = memorySession(session({ accessToken: "newer" }), "acct_obsolete_update")
    const update = jest.fn(async () => session({ organizationId: "org_old" }))
    await expect(updateLogtoSession(session(), update, state.deps)).rejects.toThrow("superseded")
    expect(update).not.toHaveBeenCalled()
  })

  it("validates an organization update before persisting its token", async () => {
    const original = session()
    const state = memorySession(original, "acct_rejected_org_update")
    const candidate = session({ accessToken: "org-candidate" })
    await expect(
      updateLogtoSession(original, async () => candidate, {
        ...state.deps,
        beforeCommit: async () => {
          throw new Error("profile owner mismatch")
        },
      })
    ).rejects.toThrow("profile owner mismatch")
    expect(state.current()).toBe(original)
  })

  it("does not resurrect a refreshed session after logout", async () => {
    const state = memorySession(session({ expiresAt: NOW - 1 }), "acct_refresh_logout")
    const response = deferred<LogtoSession>()
    const started = deferred<void>()
    const refreshing = resolveLogtoSession({
      ...state.deps,
      refresh: async () => {
        started.resolve()
        return response.promise
      },
    })
    await started.promise
    await signOutFromLogto(state.deps)
    response.resolve(session({ accessToken: "late-refresh" }))
    expect(await refreshing).toEqual({ status: "none" })
    expect(state.current()).toBeNull()
  })

  it("does not overwrite a newer login with an older successful refresh", async () => {
    const state = memorySession(session({ expiresAt: NOW - 1 }), "acct_refresh_new_login")
    const response = deferred<LogtoSession>()
    const started = deferred<void>()
    const refreshing = resolveLogtoSession({
      ...state.deps,
      refresh: async () => {
        started.resolve()
        return response.promise
      },
    })
    await started.promise
    const newer = session({ accessToken: "new-person", refreshToken: "new-refresh" })
    await signInToLogto(config, drivers, { ...state.deps, login: async () => newer })
    response.resolve(session({ accessToken: "old-person-refreshed" }))
    expect(await refreshing).toEqual({ status: "active", session: newer })
    expect(state.current()).toBe(newer)
  })

  it("does not mark a newer session revoked after an older refresh fails", async () => {
    const state = memorySession(session({ expiresAt: NOW - 1 }), "acct_refusal_new_login")
    const response = deferred<LogtoSession>()
    const started = deferred<void>()
    const markReauth = jest.fn(async () => {})
    const refreshing = resolveLogtoSession({
      ...state.deps,
      markReauth,
      refresh: async () => {
        started.resolve()
        return response.promise
      },
    })
    await started.promise
    const newer = session({ accessToken: "new-person", refreshToken: "new-refresh" })
    await signInToLogto(config, drivers, { ...state.deps, login: async () => newer })
    response.reject(
      new LogtoRefreshError("invalid_grant", "refused", { oauthError: "invalid_grant" })
    )
    expect(await refreshing).toEqual({ status: "active", session: newer })
    expect(markReauth).not.toHaveBeenCalled()
  })

  it("finishes local identity cleanup before issuer work and cannot clear a later login", async () => {
    const state = memorySession(session(), "acct_logout_new_login")
    const revocation = deferred<{ status: "revoked" }>()
    const started = deferred<void>()
    const afterClear = jest.fn(async () => {
      expect(state.current()).toBeNull()
    })
    const loggingOut = signOutFromLogto({
      ...state.deps,
      afterClear,
      revoke: async () => {
        started.resolve()
        return revocation.promise
      },
    })
    await started.promise
    expect(afterClear).toHaveBeenCalledTimes(1)
    const newer = session({ accessToken: "new-login" })
    await signInToLogto(config, drivers, { ...state.deps, login: async () => newer })
    revocation.resolve({ status: "revoked" })
    await loggingOut
    expect(state.current()).toBe(newer)
    expect(afterClear).toHaveBeenCalledTimes(1)
  })

  it("does not deactivate ownership or report success when credential deletion fails", async () => {
    const state = memorySession(session(), "acct_logout_delete_failure")
    const afterClear = jest.fn(async () => {})
    await expect(
      signOutFromLogto({
        ...state.deps,
        afterClear,
        clear: async () => {
          throw new Error("native deletion denied")
        },
      })
    ).rejects.toThrow("native deletion denied")
    expect(afterClear).not.toHaveBeenCalled()
    expect(state.current()).not.toBeNull()
  })
})

describe("resolveLogtoSession", () => {
  it("is `none` when nothing is stored and no marker was left", async () => {
    const resolved = await resolveLogtoSession(base({ load: jest.fn(async () => null) }))
    expect(resolved).toEqual({ status: "none" })
  })

  it("surfaces a stored re-authentication marker when the session is gone", async () => {
    const metadata = {
      issuer: "https://logto.test/oidc",
      clientId: "app_1",
      resource: "r",
      scopes: [],
    }
    const resolved = await resolveLogtoSession(
      base({
        load: jest.fn(async () => null),
        loadReauth: jest.fn(async () => ({ reason: "revoked" as const, metadata, at: NOW })),
      })
    )
    expect(resolved).toEqual({ status: "reauth-required", reason: "revoked", metadata })
  })

  it("returns a fresh session as active without refreshing", async () => {
    const s = session({ expiresAt: NOW + 3_600_000 })
    const refresh = jest.fn()
    const resolved = await resolveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(resolved).toEqual({ status: "active", session: s })
    expect(refresh).not.toHaveBeenCalled()
  })

  it("an expired session with no refresh token is dead, not active", async () => {
    // This is the case the old shape got wrong: a token past its expiry came
    // back as a session and every consumer presented it.
    const s = session({ expiresAt: NOW - 1, refreshToken: undefined })
    const markReauth = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), markReauth, localAccountId: "acct_a" })
    )
    expect(resolved.status).toBe("reauth-required")
    if (resolved.status !== "reauth-required") throw new Error("unreachable")
    expect(resolved.reason).toBe("expired")
    expect(resolved.metadata).toMatchObject({ issuer: s.issuer, clientId: "app_1" })
    expect(resolved.metadata).not.toHaveProperty("accessToken")
    expect(markReauth).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "expired", at: NOW }),
      "acct_a"
    )
  })

  it("refreshes and persists when the token is within the skew window", async () => {
    const s = session({ expiresAt: NOW + REFRESH_SKEW_MS - 1 })
    const refreshed = session({ accessToken: "at2", expiresAt: NOW + 3_600_000 })
    const refresh = jest.fn<
      Promise<LogtoSession>,
      Parameters<NonNullable<LogtoAppSessionDeps["refresh"]>>
    >(async () => refreshed)
    const save = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, save, localAccountId: "acct_a" })
    )
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]![1]).toBe("rt")
    expect(save).toHaveBeenCalledWith(refreshed, "acct_a")
    expect(resolved).toEqual({ status: "active", session: refreshed })
  })

  it("an invalid_grant clears the tokens and leaves a marker naming the reason", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "refused", {
        status: 400,
        oauthError: "invalid_grant",
        oauthErrorDescription: "grant request is invalid",
      })
    })
    const save = jest.fn(async () => {})
    const markReauth = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, save, markReauth })
    )
    expect(resolved).toMatchObject({ status: "reauth-required", reason: "revoked" })
    expect(save).not.toHaveBeenCalled()
    expect(markReauth).toHaveBeenCalledTimes(1)
  })

  it("concurrent callers share one refresh instead of racing the rotated token", async () => {
    let stored = session({ expiresAt: NOW - 1 })
    const refreshed = session({ accessToken: "at2", refreshToken: "rt2" })
    let release!: () => void
    const started = deferred<void>()
    const refresh = jest.fn(async () => {
      started.resolve()
      await new Promise<void>((resolve) => (release = resolve))
      return refreshed
    })
    const deps = base({
      load: jest.fn(async () => stored),
      refresh,
      save: jest.fn(async (next: LogtoSession) => {
        stored = next
      }),
      localAccountId: "acct_race",
    })
    const results = Promise.all([resolveLogtoSession(deps), resolveLogtoSession(deps)])
    await started.promise
    release()
    expect(await results).toEqual([
      { status: "active", session: refreshed },
      { status: "active", session: refreshed },
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("re-reads the session once it holds the lock, so a refresh another tab made is reused", async () => {
    const stale = session({ expiresAt: NOW - 1 })
    const fresh = session({ accessToken: "at2", refreshToken: "rt2" })
    const load = jest.fn().mockResolvedValueOnce(stale).mockResolvedValue(fresh)
    const refresh = jest.fn()
    const request = jest.fn((_name: string, task: () => Promise<unknown>) => task())
    const resolved = await resolveLogtoSession(
      base({ load, refresh, locks: { request } as never, localAccountId: "acct_tabs" })
    )
    expect(request).toHaveBeenCalledWith("cognia-logto-refresh:acct_tabs", expect.any(Function))
    expect(refresh).not.toHaveBeenCalled()
    expect(resolved).toEqual({ status: "active", session: fresh })
  })

  it("a refusal after someone else rotated the token returns their session, not a dead login", async () => {
    const stale = session({ expiresAt: NOW - 1 })
    const theirs = session({ accessToken: "at2", refreshToken: "rt2" })
    const load = jest
      .fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValue(theirs)
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "refused", {
        status: 400,
        oauthError: "invalid_grant",
      })
    })
    const markReauth = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load, refresh, markReauth, localAccountId: "acct_rotated" })
    )
    expect(resolved).toEqual({ status: "active", session: theirs })
    expect(markReauth).not.toHaveBeenCalled()
  })

  it("reads an expiry description as `expired` rather than `revoked`", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "refused", {
        oauthError: "invalid_grant",
        oauthErrorDescription: "refresh token is expired",
      })
    })
    const resolved = await resolveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(resolved).toMatchObject({ status: "reauth-required", reason: "expired" })
  })

  it("a network failure keeps the material and reports offline", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("network", "fetch failed")
    })
    const markReauth = jest.fn(async () => {})
    const save = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, markReauth, save })
    )
    expect(resolved).toMatchObject({ status: "offline", metadata: { issuer: s.issuer } })
    // Nothing was written: the refresh token still works and must survive.
    expect(markReauth).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it("a 5xx from the issuer is offline too, not a revocation", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("server", "503", { status: 503 })
    })
    const resolved = await resolveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(resolved.status).toBe("offline")
  })

  it("a rejected refresh (misconfiguration) is an error with the material kept", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("rejected", "invalid_client", { oauthError: "invalid_client" })
    })
    const markReauth = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, markReauth })
    )
    expect(resolved).toMatchObject({ status: "error", reason: "invalid_client" })
    expect(markReauth).not.toHaveBeenCalled()
  })

  it("an untyped throw is an error, never a revocation", async () => {
    const s = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new Error("something else")
    })
    const markReauth = jest.fn(async () => {})
    const resolved = await resolveLogtoSession(
      base({ load: jest.fn(async () => s), refresh, markReauth })
    )
    expect(resolved).toMatchObject({ status: "error", reason: "something else" })
    expect(markReauth).not.toHaveBeenCalled()
  })

  it("threads the organization id into the refresh config", async () => {
    const s = session({ expiresAt: NOW - 1, organizationId: "org_9" })
    const refresh = jest.fn<
      Promise<LogtoSession>,
      Parameters<NonNullable<LogtoAppSessionDeps["refresh"]>>
    >(async () => session())
    await resolveLogtoSession(base({ load: jest.fn(async () => s), refresh }))
    expect(refresh.mock.calls[0]![0]).toMatchObject({ organizationId: "org_9" })
  })
})

describe("getActiveLogtoSession / readActiveAccessToken", () => {
  it("hand out a token only for the active state", async () => {
    const s = session()
    expect(await getActiveLogtoSession(base({ load: jest.fn(async () => s) }))).toBe(s)
    expect(await readActiveAccessToken("acct_a", base({ load: jest.fn(async () => s) }))).toBe("at")
  })

  it("return null for every other state, including a stale session that could not refresh", async () => {
    const stale = session({ expiresAt: NOW - 1 })
    const refresh = jest.fn(async () => {
      throw new LogtoRefreshError("network", "down")
    })
    expect(
      await getActiveLogtoSession(base({ load: jest.fn(async () => stale), refresh }))
    ).toBeNull()
    expect(
      await readActiveAccessToken("acct_a", base({ load: jest.fn(async () => stale), refresh }))
    ).toBeNull()
    expect(await getActiveLogtoSession(base({ load: jest.fn(async () => null) }))).toBeNull()
  })

  it("passes the profile through to the store", async () => {
    const load = jest.fn(async () => session())
    await readActiveAccessToken("acct_z", base({ load }))
    expect(load).toHaveBeenCalledWith("acct_z")
  })
})

describe("signOutFromLogto", () => {
  const discover = jest.fn(async () => ({
    issuer: "https://logto.test/oidc",
    authorizationEndpoint: "a",
    tokenEndpoint: "t",
    endSessionEndpoint: "https://logto.test/oidc/session/end",
  }))

  it("revokes the refresh and access tokens at the issuer, then clears both keyring entries", async () => {
    const s = session({ idToken: "idt" })
    const revoke = jest.fn(async () => ({ status: "revoked" as const }))
    const clear = jest.fn(async () => {})
    const clearReauth = jest.fn(async () => {})
    const report = await signOutFromLogto({
      load: jest.fn(async () => s),
      revoke,
      discover,
      clear,
      clearReauth,
      localAccountId: "acct_a",
    })
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(revoke.mock.calls[0]).toEqual([s, "rt", "refresh_token", platformFetch])
    expect(revoke.mock.calls[1]).toEqual([s, "at", "access_token", platformFetch])
    expect(clear).toHaveBeenCalledWith("acct_a")
    expect(clearReauth).toHaveBeenCalledWith("acct_a")
    expect(report).toMatchObject({
      hadSession: true,
      cleared: true,
      refreshTokenRevocation: { status: "revoked" },
      accessTokenRevocation: { status: "revoked" },
    })
    const url = new URL(report.endSessionUrl!)
    expect(url.origin + url.pathname).toBe("https://logto.test/oidc/session/end")
    expect(url.searchParams.get("id_token_hint")).toBe("idt")
    expect(url.searchParams.get("client_id")).toBe("app_1")
    expect(signOutLeftTokensLive(report)).toBe(false)
  })

  it("still clears locally when the issuer cannot be reached, and says so", async () => {
    const revoke = jest.fn(async () => ({ status: "failed" as const, reason: "ECONNREFUSED" }))
    const clear = jest.fn(async () => {})
    const report = await signOutFromLogto({
      load: jest.fn(async () => session()),
      revoke,
      discover: jest.fn(async () => {
        throw new Error("down")
      }),
      clear,
      clearReauth: jest.fn(async () => {}),
    })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(report.endSessionUrl).toBeNull()
    expect(signOutLeftTokensLive(report)).toBe(true)
  })

  it("clears a marker even when there was no session, and reports no revocation", async () => {
    const revoke = jest.fn()
    const clearReauth = jest.fn(async () => {})
    const report = await signOutFromLogto({
      load: jest.fn(async () => null),
      revoke,
      clear: jest.fn(async () => {}),
      clearReauth,
    })
    expect(revoke).not.toHaveBeenCalled()
    expect(clearReauth).toHaveBeenCalledTimes(1)
    expect(report).toMatchObject({
      hadSession: false,
      refreshTokenRevocation: null,
      accessTokenRevocation: null,
    })
    expect(signOutLeftTokensLive(report)).toBe(false)
  })

  it("revokes only the access token when there is no refresh token, and threads the redirect", async () => {
    const revoke = jest.fn(async () => ({ status: "revoked" as const }))
    const report = await signOutFromLogto(
      {
        load: jest.fn(async () => session({ refreshToken: undefined })),
        revoke,
        discover,
        clear: jest.fn(async () => {}),
        clearReauth: jest.fn(async () => {}),
      },
      { postLogoutRedirectUri: "https://app.test/bye" }
    )
    expect(revoke).toHaveBeenCalledTimes(1)
    expect((revoke.mock.calls[0] as unknown[])[2]).toBe("access_token")
    expect(report.refreshTokenRevocation).toBeNull()
    expect(new URL(report.endSessionUrl!).searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.test/bye"
    )
  })

  it("skips revocation when asked to", async () => {
    const revoke = jest.fn()
    const report: LogtoSignOutReport = await signOutFromLogto(
      {
        load: jest.fn(async () => session()),
        revoke,
        discover,
        clear: jest.fn(async () => {}),
        clearReauth: jest.fn(async () => {}),
      },
      { revoke: false }
    )
    expect(revoke).not.toHaveBeenCalled()
    expect(report.refreshTokenRevocation).toBeNull()
  })
})
