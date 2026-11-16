/** @jest-environment jsdom */

import { setConnectorCommandInvoker } from "@/lib/connectors/tauri/commands"
import { clearLarkOAuthPending, getLarkOAuthPending, setLarkOAuthPending } from "./oauth-pending"
import { larkPendingCredential } from "./user-key"

const T0 = 1_800_000_000_000
const TTL_MS = 10 * 60 * 1000

/**
 * Stands in for the connectors secret store. Driving the real seam (rather
 * than `jest.mock`-ing the wrapper) is what proves the store is reached
 * through the swappable invoker — the whole reason this record no longer
 * lives in `localStorage`.
 */
function fakeStore() {
  const entries = new Map<string, string>()
  const calls: string[] = []
  const invoker = async <T>(name: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(name)
    const key = `${String(args?.adapterId)}:${String(args?.credential)}`
    if (name === "connectors_keyring_set") {
      entries.set(key, String(args?.value))
      return undefined as T
    }
    if (name === "connectors_keyring_get") return (entries.get(key) ?? null) as T
    if (name === "connectors_keyring_delete") {
      entries.delete(key)
      return undefined as T
    }
    throw new Error(`unexpected command ${name}`)
  }
  return { entries, calls, invoker }
}

let store: ReturnType<typeof fakeStore>
let restore: ReturnType<typeof setConnectorCommandInvoker>

beforeEach(() => {
  store = fakeStore()
  restore = setConnectorCommandInvoker(store.invoker)
})

afterEach(() => {
  setConnectorCommandInvoker(restore)
})

const owner = { appEpoch: "app-a:secret-a" }
const person = { principal: "a".repeat(64), authorizationEpoch: "begin-epoch" }

describe("setLarkOAuthPending / getLarkOAuthPending", () => {
  it("round-trips a sign-in issued to a person and stamps ts", async () => {
    await setLarkOAuthPending(
      "lk-1",
      {
        state: "lark:lk-1:nonce",
        codeVerifier: "verifier-123",
        redirectUri: "https://tunnel.example/oauth/lark/callback",
        ...person,
        connection: { ref: "host-ref", revision: 4 },
      },
      T0
    )
    expect(await getLarkOAuthPending("lk-1", "lark:lk-1:nonce", T0)).toEqual({
      state: "lark:lk-1:nonce",
      codeVerifier: "verifier-123",
      redirectUri: "https://tunnel.example/oauth/lark/callback",
      ...person,
      connection: { ref: "host-ref", revision: 4 },
      ts: T0,
    })
  })

  it("stores under the state's own name in the adapter's secret store, never in Web Storage", async () => {
    await setLarkOAuthPending(
      "lk-1",
      { state: "s", codeVerifier: "the-verifier", redirectUri: "r", ...owner },
      T0
    )
    expect([...store.entries.keys()]).toEqual([`lk-1:${await larkPendingCredential("s")}`])
    // The headless brain's localStorage is an in-memory shim in a different
    // process from the browser that opened the dialog — a verifier there is
    // unreachable by the process that has to spend it.
    expect(localStorage.getItem(`lark-oauth-pending:lk-1`)).toBeNull()
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("the-verifier")
  })

  it("keeps several sign-ins on one adapter apart", async () => {
    await setLarkOAuthPending(
      "lk-1",
      { state: "s1", codeVerifier: "v1", redirectUri: "r", ...owner },
      T0
    )
    await setLarkOAuthPending(
      "lk-1",
      { state: "s2", codeVerifier: "v2", redirectUri: "r", ...person },
      T0
    )
    await setLarkOAuthPending(
      "lk-2",
      { state: "s1", codeVerifier: "v3", redirectUri: "r", ...owner },
      T0
    )
    expect((await getLarkOAuthPending("lk-1", "s1", T0))?.codeVerifier).toBe("v1")
    expect((await getLarkOAuthPending("lk-1", "s2", T0))?.codeVerifier).toBe("v2")
    await clearLarkOAuthPending("lk-1", "s1")
    expect(await getLarkOAuthPending("lk-1", "s1", T0)).toBeNull()
    expect(await getLarkOAuthPending("lk-1", "s2", T0)).not.toBeNull()
    expect(await getLarkOAuthPending("lk-2", "s1", T0)).not.toBeNull()
  })

  it("returns null when nothing is stored", async () => {
    expect(await getLarkOAuthPending("lk-1", "s", T0)).toBeNull()
  })

  it("returns null and evicts an expired record", async () => {
    await setLarkOAuthPending(
      "lk-1",
      { state: "s", codeVerifier: "v", redirectUri: "r", ...owner },
      T0
    )
    expect(await getLarkOAuthPending("lk-1", "s", T0 + TTL_MS)).not.toBeNull()
    expect(await getLarkOAuthPending("lk-1", "s", T0 + TTL_MS + 1)).toBeNull()
    // Evicted, not merely hidden — a stale verifier must not linger encrypted
    // on disk waiting for a clock change.
    expect(store.entries.size).toBe(0)
  })

  it("returns null for a malformed, half-written, mislabelled or unbound record", async () => {
    const key = `lk-1:${await larkPendingCredential("s")}`
    const complete = { state: "s", codeVerifier: "v", redirectUri: "r", ts: T0 }
    for (const raw of [
      "not json",
      JSON.stringify({ state: "s" }),
      JSON.stringify(null),
      // Names nobody it may authorize.
      JSON.stringify(complete),
      // A person without the epoch captured for them.
      JSON.stringify({ ...complete, principal: "a".repeat(64) }),
      // Stored under this state's name but carrying another.
      JSON.stringify({ ...complete, ...owner, state: "other" }),
    ]) {
      store.entries.set(key, raw)
      expect(await getLarkOAuthPending("lk-1", "s", T0)).toBeNull()
    }
  })

  it("treats an unreachable store as absent rather than throwing", async () => {
    setConnectorCommandInvoker(async () => {
      throw new Error("no host")
    })
    // The caller's next step is "retry Connect" either way; a throw here would
    // surface as an unhandled rejection inside the OAuth completion path.
    await expect(getLarkOAuthPending("lk-1", "s", T0)).resolves.toBeNull()
    await expect(clearLarkOAuthPending("lk-1", "s")).resolves.toBeUndefined()
  })

  it("uses the current clock when none is supplied", async () => {
    await setLarkOAuthPending("lk-1", { state: "s", codeVerifier: "v", redirectUri: "r", ...owner })
    expect((await getLarkOAuthPending("lk-1", "s"))?.ts).toBeGreaterThan(0)
  })

  it("clears idempotently", async () => {
    await clearLarkOAuthPending("lk-1", "s")
    await clearLarkOAuthPending("lk-1", "s")
    expect(store.calls.filter((c) => c === "connectors_keyring_delete")).toHaveLength(2)
  })
})
