/** @jest-environment jsdom */
import {
  assertSharedChatClientEnabled,
  isSharedChatClientEnabled,
  readSharedChatPreference,
  writeSharedChatPreference,
} from "./shared-chat-feature"

function memoryStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    local: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    },
    read: (key: string) => map.get(key) ?? null,
  }
}

describe("the machine's own gate", () => {
  it("allows shared chat unless this machine said no", () => {
    expect(isSharedChatClientEnabled(memoryStore())).toBe(true)
    expect(
      isSharedChatClientEnabled(memoryStore({ "cognia.collab.shared-chat-enabled": "true" }))
    ).toBe(true)
    expect(
      isSharedChatClientEnabled(memoryStore({ "cognia.collab.shared-chat-enabled": "false" }))
    ).toBe(false)
  })

  it("throws the refusal every write path names once the machine said no", () => {
    localStorage.clear()
    expect(() => assertSharedChatClientEnabled()).not.toThrow()
    writeSharedChatPreference(false)
    expect(() => assertSharedChatClientEnabled()).toThrow("SHARED_CHAT_DISABLED")
    writeSharedChatPreference(undefined)
    expect(() => assertSharedChatClientEnabled()).not.toThrow()
  })

  it("no longer reads a build switch", () => {
    // The plane is detected (`./shared-chat-availability.ts`); a stale build
    // variable must not turn a machine's yes into a no.
    const previous = process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED
    process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED = "false"
    try {
      expect(isSharedChatClientEnabled(memoryStore())).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED
      else process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED = previous
    }
  })
})

describe("shared chat local preference", () => {
  it("treats a machine that never chose as opted in", () => {
    const store = memoryStore()
    expect(readSharedChatPreference(store)).toBeUndefined()
    expect(isSharedChatClientEnabled(store)).toBe(true)
  })

  it("round-trips a choice and forgets it again", () => {
    const store = memoryStore()
    writeSharedChatPreference(false, store)
    expect(readSharedChatPreference(store)).toBe(false)
    writeSharedChatPreference(true, store)
    expect(readSharedChatPreference(store)).toBe(true)
    writeSharedChatPreference(undefined, store)
    expect(readSharedChatPreference(store)).toBeUndefined()
  })

  it("ignores a stored value that is not a boolean", () => {
    const store = memoryStore({ "cognia.collab.shared-chat-enabled": "yes please" })
    expect(readSharedChatPreference(store)).toBeUndefined()
  })

  it("survives storage that throws", () => {
    const hostile = {
      local: {
        getItem: () => {
          throw new Error("blocked")
        },
        setItem: () => {
          throw new Error("blocked")
        },
        removeItem: () => {
          throw new Error("blocked")
        },
      },
    }
    expect(readSharedChatPreference(hostile)).toBeUndefined()
    expect(() => writeSharedChatPreference(false, hostile)).not.toThrow()
    expect(isSharedChatClientEnabled(hostile)).toBe(true)
  })
})
