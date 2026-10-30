import type { AgentSession } from "../session-runner"

import { createProviderSessionLease, providerSessionKey } from "./provider-session"

function fakeSession(log: string[], label: string): AgentSession {
  return {
    send: async () => ({ text: "", usage: undefined }),
    close: async () => {
      log.push(`close:${label}`)
    },
  } as unknown as AgentSession
}

describe("createProviderSessionLease", () => {
  it("builds on first use and reuses the same session for the same key", () => {
    const built: string[] = []
    const lease = createProviderSessionLease()
    const build = () => {
      built.push("built")
      return fakeSession([], "a")
    }

    const first = lease.session("k1", build)
    const second = lease.session("k1", build)

    expect(second).toBe(first)
    expect(built).toEqual(["built"])
  })

  it("keeps the conversation alive across turns — the whole point", () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    lease.session("k1", () => fakeSession(log, "a"))
    lease.session("k1", () => fakeSession(log, "b"))
    // Nothing closed between the two turns.
    expect(log).toEqual([])
  })

  it("reports which key and session are open", () => {
    const lease = createProviderSessionLease()
    expect(lease.openKey).toBeNull()
    expect(lease.current).toBeNull()
    const session = lease.session("k1", () => fakeSession([], "a"))
    expect(lease.openKey).toBe("k1")
    expect(lease.current).toBe(session)
  })

  it("rebuilds — closing the old session — when the key changes", async () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    const first = lease.session("builtin", () => fakeSession(log, "a"))
    const second = await lease.replace("codex", () => fakeSession(log, "b"))

    // A caller that switched backend must not keep talking to the old one.
    expect(second).not.toBe(first)
    expect(log).toEqual(["close:a"])
    expect(lease.openKey).toBe("codex")
  })

  it("closes the live session and forgets it", async () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    lease.session("k1", () => fakeSession(log, "a"))
    await lease.close()

    expect(log).toEqual(["close:a"])
    expect(lease.openKey).toBeNull()
  })

  it("makes close idempotent, and a no-op before anything was built", async () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    await lease.close()
    lease.session("k1", () => fakeSession(log, "a"))
    await lease.close()
    await lease.close()
    expect(log).toEqual(["close:a"])
  })

  it("builds a fresh session after a close", async () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    const first = lease.session("k1", () => fakeSession(log, "a"))
    await lease.close()
    const second = lease.session("k1", () => fakeSession(log, "b"))
    expect(second).not.toBe(first)
  })

  it("shares teardown proof across concurrent close and replace calls", async () => {
    const lease = createProviderSessionLease()
    let release!: () => void
    const close = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    lease.session("k1", () => ({ close }) as unknown as AgentSession)
    const first = lease.close()
    const second = lease.close()
    const build = jest.fn(() => fakeSession([], "b"))
    const replacement = lease.replace("k2", build)
    await Promise.resolve()
    expect(build).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second, replacement])
    expect(build).toHaveBeenCalledTimes(1)
  })

  it("does not reuse or replace a session whose executor stop is unconfirmed", async () => {
    const lease = createProviderSessionLease()
    const exploding = {
      close: async () => {
        throw new Error("sidecar already gone")
      },
    } as unknown as AgentSession

    lease.session("k1", () => exploding)
    await expect(lease.close()).rejects.toThrow("sidecar already gone")
    expect(lease.openKey).toBeNull()
    await expect(lease.close()).rejects.toThrow("sidecar already gone")
    const build = jest.fn(() => fakeSession([], "b"))
    await expect(lease.replace("k1", build)).rejects.toThrow("sidecar already gone")
    expect(() => lease.session("k1", build)).toThrow(/teardown/)
    expect(build).not.toHaveBeenCalled()
  })
})

describe("providerSessionKey", () => {
  it("separates sessions that are genuinely not interchangeable", () => {
    const base = { sessionId: "s1", backendId: "builtin", model: "opus", cwd: "/repo" }
    expect(providerSessionKey(base)).toBe(providerSessionKey({ ...base }))
    expect(providerSessionKey({ ...base, backendId: "codex" })).not.toBe(providerSessionKey(base))
    expect(providerSessionKey({ ...base, sessionId: "s2" })).not.toBe(providerSessionKey(base))
    expect(providerSessionKey({ ...base, model: "sonnet" })).not.toBe(providerSessionKey(base))
    expect(providerSessionKey({ ...base, cwd: "/other" })).not.toBe(providerSessionKey(base))
  })

  it("tolerates the optional fields being absent", () => {
    expect(providerSessionKey({ sessionId: "s1", backendId: "builtin" })).toBe(
      providerSessionKey({ sessionId: "s1", backendId: "builtin" })
    )
  })

  it("does not fold in per-turn knobs, which would discard context on every toggle", () => {
    // Approval mode and the tool allow-list are re-applied per `send`. If they
    // were part of the key, flipping one would rebuild the session and lose the
    // conversation.
    const key = providerSessionKey({ sessionId: "s1", backendId: "builtin", model: "opus" })
    expect(key).not.toContain("approval")
    expect(key).not.toContain("tools")
  })
})
