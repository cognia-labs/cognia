/**
 * Tests for `chat-participant-registry`.
 *
 * Each VS Code chat participant becomes a virtual `Character` in cognia's
 * Dexie `characters` table. We inject a memory store via
 * `configureChatRegistry` so the suite stays Dexie-free.
 */

import {
  __listParticipantsForTesting,
  __resetChatRegistryForTesting,
  configureChatRegistry,
  disposeAllParticipantsFor,
  handleChatParticipantRespond,
  handleCreateChatParticipant,
  handleDisposeChatParticipant,
  handleRegisterChatVariableResolver,
  handleUnregisterChatVariableResolver,
  runVscodeChatParticipant,
  listVscodeChatParticipantCharacters,
  cancelVscodeChatParticipantSession,
} from "./chat-participant-registry"
import type { Character } from "@cognia/agent-config-types"

function makeMemoryStore() {
  const characters = new Map<string, Character>()
  configureChatRegistry({
    upsertCharacter: async (character) => {
      characters.set(character.id, character)
    },
  })
  return characters
}

describe("chat-participant-registry", () => {
  beforeEach(() => {
    __resetChatRegistryForTesting()
  })

  describe("handleCreateChatParticipant", () => {
    it("upserts a virtual Character and tracks the handle", async () => {
      const characters = makeMemoryStore()
      const { characterId } = await handleCreateChatParticipant({
        extensionId: "ext.cline",
        id: "cline",
        name: "Cline",
        description: "AI coding assistant",
        iconEmoji: "🤖",
        respondToken: "respond-1",
      })
      expect(characterId).toBe("vscode-chat:ext.cline:cline")
      expect(characters.get(characterId)).toEqual(
        expect.objectContaining({
          id: characterId,
          name: "Cline",
          description: "AI coding assistant",
          avatarEmoji: "🤖",
          systemPrompt: "",
        })
      )
      expect(__listParticipantsForTesting()).toEqual([
        expect.objectContaining({
          pluginId: "ext.cline",
          participantId: "cline",
          characterId,
          respondToken: "respond-1",
        }),
      ])
    })

    it("treats a second registration as an update, not a duplicate", async () => {
      const characters = makeMemoryStore()
      const first = await handleCreateChatParticipant({
        extensionId: "ext",
        id: "p",
        respondToken: "t1",
      })
      const second = await handleCreateChatParticipant({
        extensionId: "ext",
        id: "p",
        respondToken: "t2",
      })
      expect(second.characterId).toBe(first.characterId)
      expect(__listParticipantsForTesting()).toHaveLength(1)
      expect(__listParticipantsForTesting()[0]!.respondToken).toBe("t2")
      // Only one upsert + the same character body remains.
      expect(characters.size).toBe(1)
    })

    it("survives an upsertCharacter failure (warn + continue)", async () => {
      configureChatRegistry({
        upsertCharacter: async () => {
          throw new Error("dexie unavailable")
        },
      })
      const { characterId } = await handleCreateChatParticipant({
        extensionId: "ext.x",
        id: "p",
      })
      expect(characterId).toBe("vscode-chat:ext.x:p")
      // Handle is still recorded so dispose can clean up.
      expect(__listParticipantsForTesting()).toHaveLength(1)
    })
  })

  describe("handleDisposeChatParticipant", () => {
    it("removes the callback while retaining the character's user settings", async () => {
      const characters = makeMemoryStore()
      await handleCreateChatParticipant({ extensionId: "ext", id: "p" })
      expect(characters.size).toBe(1)
      await handleDisposeChatParticipant({ extensionId: "ext", id: "p" })
      expect(characters.size).toBe(1)
      expect(__listParticipantsForTesting()).toHaveLength(0)
    })

    it("is a no-op when the participant is unknown", async () => {
      makeMemoryStore()
      await expect(
        handleDisposeChatParticipant({ extensionId: "ext", id: "missing" })
      ).resolves.toBeUndefined()
    })
  })

  describe("handleRegisterChatVariableResolver", () => {
    it("attaches the resolver token to the participant handle", async () => {
      makeMemoryStore()
      await handleCreateChatParticipant({ extensionId: "ext", id: "p" })
      const result = handleRegisterChatVariableResolver({
        extensionId: "ext",
        participantId: "p",
        name: "selection",
        token: "var-1",
      })
      expect(result).toEqual({ registered: true })
      expect(__listParticipantsForTesting()[0]!.variableResolverToken).toBe("var-1")
    })

    it("throws when the participant doesn't exist", () => {
      makeMemoryStore()
      expect(() =>
        handleRegisterChatVariableResolver({
          extensionId: "ext",
          participantId: "missing",
          name: "x",
          token: "t",
        })
      ).toThrow(/missing.*is not registered/)
    })

    it("accepts the canonical sidecar id field and clears it on unregister", async () => {
      makeMemoryStore()
      await handleCreateChatParticipant({ extensionId: "ext", id: "p" })
      handleRegisterChatVariableResolver({ extensionId: "ext", id: "p", token: "var-2" })
      expect(__listParticipantsForTesting()[0]!.variableResolverToken).toBe("var-2")

      handleUnregisterChatVariableResolver({ extensionId: "ext", id: "p" })
      expect(__listParticipantsForTesting()[0]!.variableResolverToken).toBeUndefined()
    })
  })

  describe("handleChatParticipantRespond", () => {
    it("rejects response parts for inactive requests", async () => {
      await expect(
        handleChatParticipantRespond({
          extensionId: "ext",
          id: "p",
          requestId: "missing",
          part: { kind: "markdown", value: "late" },
        })
      ).rejects.toThrow("inactive")
    })
  })

  describe("disposeAllParticipantsFor", () => {
    it("drops every handle for the given extension only and retains stored profiles", async () => {
      const characters = makeMemoryStore()
      await handleCreateChatParticipant({ extensionId: "ext.a", id: "p1" })
      await handleCreateChatParticipant({ extensionId: "ext.a", id: "p2" })
      await handleCreateChatParticipant({ extensionId: "ext.b", id: "p3" })
      expect(characters.size).toBe(3)
      await disposeAllParticipantsFor("ext.a")
      expect(characters.size).toBe(3)
      const remaining = __listParticipantsForTesting()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.pluginId).toBe("ext.b")
    })

    it("disposes every callback even if profile initialization failed", async () => {
      configureChatRegistry({
        upsertCharacter: async () => {
          throw new Error("dexie boom")
        },
      })
      await handleCreateChatParticipant({ extensionId: "ext", id: "p1" })
      await handleCreateChatParticipant({ extensionId: "ext", id: "p2" })
      await disposeAllParticipantsFor("ext")
      // Runtime teardown never depends on profile storage being available.
      expect(__listParticipantsForTesting()).toHaveLength(0)
    })
  })
})

it("binds the canonical sidecar token and routes ordered owned response parts", async () => {
  __resetChatRegistryForTesting()
  makeMemoryStore()
  const received: unknown[] = []
  configureChatRegistry({
    activate: async () => {},
    canInvoke: async () => true,
    callProvider: async (_pluginId, _method, raw) => {
      const request = raw as { requestId: string }
      await handleChatParticipantRespond({
        extensionId: "ext",
        id: "participant",
        requestId: request.requestId,
        part: { kind: "markdown", value: "hello" },
      })
      await expect(
        handleChatParticipantRespond({
          extensionId: "ext",
          id: "participant",
          requestId: request.requestId,
          part: { kind: "reference", value: "file:///private/example" },
        })
      ).rejects.toThrow("HTTP(S)")
      await expect(
        handleChatParticipantRespond({
          extensionId: "other",
          id: "participant",
          requestId: request.requestId,
          part: { kind: "markdown", value: "spoofed" },
        })
      ).rejects.toThrow("ownership")
      return { metadata: { complete: true } }
    },
  })
  await handleCreateChatParticipant({ extensionId: "ext", id: "participant", token: "canonical" })
  expect(__listParticipantsForTesting()[0]?.respondToken).toBe("canonical")
  const result = await runVscodeChatParticipant({
    characterId: "vscode-chat:ext:participant",
    prompt: "question",
    sessionId: "s",
    onPart: async (part) => {
      received.push(part)
    },
  })
  expect(received).toEqual([{ kind: "markdown", value: "hello" }])
  expect(result).toEqual({ text: "hello", metadata: { complete: true } })
  await expect(
    handleChatParticipantRespond({
      extensionId: "ext",
      id: "participant",
      requestId: "stale",
      part: { kind: "markdown", value: "late" },
    })
  ).rejects.toThrow("inactive")
})

it("refuses disabled participants and aborts calls when the owning extension is disposed", async () => {
  __resetChatRegistryForTesting()
  makeMemoryStore()
  await handleCreateChatParticipant({ extensionId: "ext", id: "participant", token: "provider" })
  const provider = jest.fn()
  configureChatRegistry({
    activate: async () => {},
    canInvoke: async () => false,
    callProvider: provider,
  })
  await expect(
    runVscodeChatParticipant({
      characterId: "vscode-chat:ext:participant",
      prompt: "q",
      sessionId: "s",
    })
  ).rejects.toThrow("disabled")
  expect(provider).not.toHaveBeenCalled()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  configureChatRegistry({
    canInvoke: async () => true,
    callProvider: async (_id, _method, _payload, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true }
        )
        started()
      }),
  })
  const pending = runVscodeChatParticipant({
    characterId: "vscode-chat:ext:participant",
    prompt: "q",
    sessionId: "s",
  })
  const rejection = expect(pending).rejects.toThrow("cancelled")
  await ready
  await disposeAllParticipantsFor("ext")
  await rejection
})

it("discovers declared participants without starting the extension, then activates the selected owner", async () => {
  __resetChatRegistryForTesting()
  makeMemoryStore()
  const activate = jest.fn(async () => {
    await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "callback" })
  })
  configureChatRegistry({
    declarations: async () => [{ pluginId: "ext", id: "helper", name: "Helpful extension" }],
    activate,
    canInvoke: async () => true,
    callProvider: async () => ({}),
  })
  expect(await listVscodeChatParticipantCharacters()).toEqual([
    expect.objectContaining({
      id: "vscode-chat:ext:helper",
      name: "Helpful extension",
      sourcePluginId: "ext",
    }),
  ])
  expect(activate).not.toHaveBeenCalled()
  await runVscodeChatParticipant({
    characterId: "vscode-chat:ext:helper",
    prompt: "q",
    sessionId: "s",
  })
  expect(activate).toHaveBeenCalledWith("helper")
})

it("does not resurrect a participant disposed while its character write is pending", async () => {
  __resetChatRegistryForTesting()
  let finish!: () => void
  configureChatRegistry({
    upsertCharacter: async () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  })
  const pending = handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "old" })
  const rejection = expect(pending).rejects.toThrow("cancelled or replaced")
  await disposeAllParticipantsFor("ext")
  finish()
  await rejection
  expect(__listParticipantsForTesting()).toEqual([])
})

it("blocks private stored history before the extension callback", async () => {
  __resetChatRegistryForTesting()
  makeMemoryStore()
  const provider = jest.fn(async () => ({}))
  configureChatRegistry({
    activate: async () => {},
    canInvoke: async () => true,
    callProvider: provider,
  })
  await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "callback" })
  await expect(
    runVscodeChatParticipant({
      characterId: "vscode-chat:ext:helper",
      sessionId: "s",
      prompt: "summarize",
      history: [{ role: "user", content: "contact alice@example.com" }],
    })
  ).rejects.toMatchObject({ name: "PluginPiiError" })
  expect(provider).not.toHaveBeenCalled()
})

it("refuses a replaced frozen registration before invoking its callback", async () => {
  __resetChatRegistryForTesting()
  makeMemoryStore()
  const provider = jest.fn()
  configureChatRegistry({
    activate: async () => {},
    canInvoke: async () => true,
    callProvider: provider,
  })
  await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "first" })
  const generation = __listParticipantsForTesting()[0]!.generation
  await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "second" })
  await expect(
    runVscodeChatParticipant({
      characterId: "vscode-chat:ext:helper",
      sessionId: "s",
      prompt: "q",
      generation,
    })
  ).rejects.toThrow("registration changed")
  expect(provider).not.toHaveBeenCalled()
})

it("isolates session cancellation and aborts every remaining call on extension disposal", async () => {
  __resetChatRegistryForTesting()
  makeMemoryStore()
  const signals: AbortSignal[] = []
  let ready!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  configureChatRegistry({
    activate: async () => {},
    canInvoke: async () => true,
    callProvider: async (_id, _method, _raw, signal) =>
      new Promise((_resolve, reject) => {
        signals.push(signal!)
        signal!.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true }
        )
        if (signals.length === 2) ready()
      }),
  })
  await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "callback" })
  const first = runVscodeChatParticipant({
    characterId: "vscode-chat:ext:helper",
    sessionId: "s1",
    prompt: "q",
  })
  const second = runVscodeChatParticipant({
    characterId: "vscode-chat:ext:helper",
    sessionId: "s2",
    prompt: "q",
  })
  const firstCheck = expect(first).rejects.toMatchObject({ name: "AbortError" })
  const secondCheck = expect(second).rejects.toMatchObject({ name: "AbortError" })
  await started
  cancelVscodeChatParticipantSession("s1")
  await firstCheck
  expect(signals[1]!.aborted).toBe(false)
  await disposeAllParticipantsFor("ext")
  await secondCheck
})

it.each([null, false, 0, "state", ["saved", 1], { nested: true }])(
  "preserves JSON result metadata %j",
  async (metadata) => {
    __resetChatRegistryForTesting()
    makeMemoryStore()
    configureChatRegistry({
      activate: async () => {},
      canInvoke: async () => true,
      callProvider: async () => ({ metadata }),
    })
    await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "callback" })
    await expect(
      runVscodeChatParticipant({
        characterId: "vscode-chat:ext:helper",
        sessionId: "s",
        prompt: "q",
      })
    ).resolves.toEqual({ text: "", metadata })
  }
)
