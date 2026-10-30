/**
 * `vscode.chat` participant registry — maps VS Code chat participants into
 * cognia's Character system.
 *
 * Each extension that calls `chat.createChatParticipant(id, handler)` lands
 * here through the renderer-side RPC dispatcher. We upsert a virtual
 * `Character` (id pattern `vscode-chat:${pluginId}:${id}`) into the Dexie
 * `characters` table so cognia's existing character chooser, inbox, and
 * chat composer treat it like any first-party character.
 *
 * Invocation uses the same extension callback and cancellation transport as
 * language providers. Response parts belong to one live request and owner.
 */

import type { Character } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { loggers } from "@cognia/logging"
import { hasApiOrGuardPermission } from "@/lib/plugin/api/api-permission-gate"
import { assertNoLeakingPiiDeep } from "@/lib/plugin/api/plugin-pii-gate"

const chatLogger = loggers.plugin.child("vscode-chat")

export interface ParticipantHandle {
  pluginId: string
  participantId: string
  characterId: string
  /** Token the sidecar gave us for `respond` callbacks. */
  respondToken?: string
  generation: string
  /** Token for `chatVariableResolver`. */
  variableResolverToken?: string
}

const participants = new Map<string, ParticipantHandle>()

function buildCharacterId(pluginId: string, participantId: string): string {
  return `vscode-chat:${pluginId}:${participantId}`
}

interface CreateParticipantPayload {
  extensionId: string
  /** Participant id as declared by `chat.createChatParticipant(id, …)`. */
  id: string
  /** Display name (defaults to `id` when omitted). */
  name?: string
  /** Optional one-line description shown in cognia's chooser. */
  description?: string
  /** Optional emoji used for the avatar. */
  iconEmoji?: string
  /** Token the sidecar gave us so we can call the participant later. */
  respondToken?: string
  token?: string
}

interface DisposeParticipantPayload {
  extensionId: string
  id: string
  token?: string
}

interface RegisterVariableResolverPayload {
  extensionId: string
  /** Participant the resolver belongs to. */
  participantId?: string
  /** Canonical sidecar field; retained separately from participantId for legacy callers. */
  id?: string
  /** Legacy metadata field accepted from older callers. */
  name?: string
  token: string
}

export type ChatParticipantPart =
  { kind: "markdown" | "progress"; value: string } | { kind: "reference"; value: string }

export interface ChatParticipantHistoryTurn {
  role: "user" | "assistant"
  content: string
  participant?: string
  result?: { metadata?: unknown }
}

interface ParticipantRespondPayload {
  /** Plugin/extension that owns the participant. */
  extensionId: string
  /** Participant id. */
  id: string
  requestId: string
  part: ChatParticipantPart
}

/**
 * Test-only override hooks for the storage layer. Production code uses
 * the real `getDb()` Dexie store; tests inject an in-memory stand-in to
 * keep the suite Dexie-free.
 */
interface ChatRegistryDeps {
  declarations: () => Promise<
    Array<{ pluginId: string; id: string; name: string; description?: string }>
  >
  upsertCharacter: (character: Character) => Promise<void>
  activate: (participantId: string) => Promise<void>
  canInvoke: (pluginId: string) => Promise<boolean>
  callProvider: (
    pluginId: string,
    method: string,
    payload: unknown,
    signal?: AbortSignal
  ) => Promise<unknown>
}

function createDefaultDeps(): ChatRegistryDeps {
  return {
    declarations: async () => {
      const { usePluginStore } = await import("@/stores/plugin-runtime/plugin-store")
      const plugins = Object.values(usePluginStore.getState().plugins).filter(
        (plugin) => plugin.manifest.vscodeExtension?.chatParticipants?.length
      )
      if (!plugins.length) return []
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      const rows = await Promise.all(
        plugins.map(async (plugin) => {
          if (
            (await getPluginManager().getPluginLifecycleState(plugin.manifest.id)).intent ===
            "disabled"
          )
            return []
          return plugin.manifest.vscodeExtension!.chatParticipants!.map((item) => ({
            ...item,
            pluginId: plugin.manifest.id,
          }))
        })
      )
      return rows.flat()
    },
    upsertCharacter: async (character) => {
      const db = getDb()
      await db.transaction("rw", db.characters, async () => {
        const stored = await db.characters.get(character.id)
        await db.characters.put({
          ...character,
          ...stored,
          id: character.id,
          sourcePluginId: character.sourcePluginId,
          availableOnPlatforms: character.availableOnPlatforms,
        })
      })
    },
    activate: async (id) => {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().handleActivationEvent(`onChatParticipant:${id}`)
    },
    canInvoke: async (id) => {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      const plugin = getPluginManager().getPlugin(id)
      return (
        plugin?.status === "enabled" &&
        (await getPluginManager().getPluginLifecycleState(id)).intent !== "disabled" &&
        hasApiOrGuardPermission(id, "session:read")
      )
    },
    callProvider: async (...args) => {
      const { callVscodeProvider } = await import("@/lib/plugin/core/vscode-loader")
      return callVscodeProvider(...args)
    },
  }
}
let deps = createDefaultDeps()
const requests = new Map<
  string,
  {
    handle: ParticipantHandle
    controller: AbortController
    text: string
    sessionId: string
    onPart?: (part: ChatParticipantPart) => void | Promise<void>
    pending: Promise<void>
  }
>()

function abortParticipant(handle: ParticipantHandle): void {
  for (const call of requests.values()) {
    if (call.handle === handle)
      call.controller.abort(new DOMException("Chat participant cancelled", "AbortError"))
  }
}

export function cancelVscodeChatParticipantSession(sessionId: string): void {
  for (const call of requests.values()) {
    if (call.sessionId === sessionId)
      call.controller.abort(new DOMException("Chat participant cancelled", "AbortError"))
  }
}

export function configureChatRegistry(overrides: Partial<ChatRegistryDeps>): void {
  deps = { ...deps, ...overrides }
}

export function __resetChatRegistryForTesting(): void {
  for (const handle of participants.values()) abortParticipant(handle)
  requests.clear()
  participants.clear()
  deps = createDefaultDeps()
}

export async function handleCreateChatParticipant(
  payload: CreateParticipantPayload
): Promise<{ characterId: string }> {
  const key = `${payload.extensionId}::${payload.id}`
  const existing = participants.get(key)
  if (existing) {
    chatLogger.debug("chat participant already registered; updating handle", {
      pluginId: payload.extensionId,
      participantId: payload.id,
    })
    abortParticipant(existing)
    existing.respondToken = payload.token ?? payload.respondToken ?? existing.respondToken
    existing.generation = globalThis.crypto.randomUUID()
    return { characterId: existing.characterId }
  }
  const characterId = buildCharacterId(payload.extensionId, payload.id)
  const now = Date.now()
  const character: Character = {
    id: characterId,
    sourcePluginId: payload.extensionId,
    name: payload.name ?? payload.id,
    description: payload.description,
    avatarColor: "oklch(0.72 0.14 285)",
    avatarEmoji: payload.iconEmoji,
    systemPrompt: "",
    availableOnPlatforms: ["tauri", "headless"],
    createdAt: now,
    updatedAt: now,
  }
  const handle: ParticipantHandle = {
    pluginId: payload.extensionId,
    participantId: payload.id,
    characterId,
    respondToken: payload.token ?? payload.respondToken,
    generation: globalThis.crypto.randomUUID(),
  }
  const generation = handle.generation
  participants.set(key, handle)
  try {
    await deps.upsertCharacter(character)
  } catch (err) {
    chatLogger.warn("upsertCharacter failed; participant will not appear in chooser", {
      pluginId: payload.extensionId,
      participantId: payload.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (participants.get(key) !== handle || handle.generation !== generation)
    throw new Error("Chat participant registration was cancelled or replaced")
  return { characterId }
}

export async function handleDisposeChatParticipant(
  payload: DisposeParticipantPayload
): Promise<void> {
  const key = `${payload.extensionId}::${payload.id}`
  const handle = participants.get(key)
  if (!handle) return
  if (payload.token && payload.token !== handle.respondToken) return
  abortParticipant(handle)
  participants.delete(key)
  // The row owns user policy/preferences. Discovery hides unavailable participants;
  // dropping a live callback must not erase restrictions on its next activation.
}

export function handleRegisterChatVariableResolver(payload: RegisterVariableResolverPayload): {
  registered: true
} {
  const participantId = payload.participantId ?? payload.id
  if (!participantId) throw new Error("chat variable resolver requires participant id")
  const key = `${payload.extensionId}::${participantId}`
  const handle = participants.get(key)
  if (!handle) {
    throw new Error(
      `chat.registerChatVariableResolver: participant ${participantId} from ${payload.extensionId} is not registered`
    )
  }
  handle.variableResolverToken = payload.token
  return { registered: true }
}

export function handleUnregisterChatVariableResolver(
  payload: Omit<RegisterVariableResolverPayload, "token">
): void {
  const participantId = payload.participantId ?? payload.id
  if (!participantId) return
  const handle = participants.get(`${payload.extensionId}::${participantId}`)
  if (handle) handle.variableResolverToken = undefined
}

export async function handleChatParticipantRespond(
  payload: ParticipantRespondPayload
): Promise<void> {
  const call = requests.get(payload.requestId)
  if (!call || call.controller.signal.aborted)
    throw new Error("Chat participant request is inactive")
  if (call.handle.pluginId !== payload.extensionId || call.handle.participantId !== payload.id) {
    throw new Error("Chat participant response ownership mismatch")
  }
  const part = payload.part
  if (
    !part ||
    !["markdown", "progress", "reference"].includes(part.kind) ||
    typeof part.value !== "string"
  ) {
    throw new Error("Unsupported chat participant response part")
  }
  if (part.kind === "reference" && !/^https?:\/\//i.test(part.value))
    throw new Error("Chat participant references support HTTP(S) URLs only")
  call.pending = call.pending.then(async () => {
    if (call.controller.signal.aborted)
      throw new DOMException("Chat participant cancelled", "AbortError")
    if (part.kind === "markdown") call.text += part.value
    await call.onPart?.(part)
  })
  await call.pending
}

export async function resolveVscodeChatParticipant(
  characterId: string
): Promise<ParticipantHandle> {
  let handle = [...participants.values()].find((item) => item.characterId === characterId)
  if (!handle && characterId.startsWith("vscode-chat:")) {
    const participant = (await deps.declarations()).find(
      (item) => buildCharacterId(item.pluginId, item.id) === characterId
    )
    if (participant) await deps.activate(participant.id)
    handle = [...participants.values()].find((item) => item.characterId === characterId)
  } else if (handle) {
    await deps.activate(handle.participantId)
    handle = participants.get(`${handle.pluginId}::${handle.participantId}`)
  }
  if (!handle?.respondToken || !(await deps.canInvoke(handle.pluginId))) {
    throw new Error("Chat participant is disabled or unavailable")
  }
  return { ...handle }
}

/** Data-only discovery keeps dormant extensions selectable without running them. */
export async function listVscodeChatParticipantCharacters(): Promise<Character[]> {
  const characters = new Map<string, Character>()
  for (const item of await deps.declarations()) {
    const id = buildCharacterId(item.pluginId, item.id)
    characters.set(id, {
      id,
      name: item.name,
      description: item.description,
      sourcePluginId: item.pluginId,
      systemPrompt: "",
      availableOnPlatforms: ["tauri", "headless"],
      avatarColor: "oklch(0.72 0.14 285)",
      createdAt: 0,
      updatedAt: 0,
    })
  }
  for (const handle of participants.values()) {
    if (characters.has(handle.characterId) || !(await deps.canInvoke(handle.pluginId))) continue
    characters.set(handle.characterId, {
      id: handle.characterId,
      name: handle.participantId,
      sourcePluginId: handle.pluginId,
      systemPrompt: "",
      availableOnPlatforms: ["tauri", "headless"],
      avatarColor: "oklch(0.72 0.14 285)",
      createdAt: 0,
      updatedAt: 0,
    })
  }
  return [...characters.values()]
}

export async function runVscodeChatParticipant(input: {
  characterId: string
  prompt: string
  sessionId: string
  history?: ChatParticipantHistoryTurn[]
  signal?: AbortSignal
  generation?: string
  onPart?: (part: ChatParticipantPart) => void | Promise<void>
}): Promise<{ text: string; metadata?: unknown }> {
  input.signal?.throwIfAborted()
  const resolved = await resolveVscodeChatParticipant(input.characterId)
  const handle = participants.get(`${resolved.pluginId}::${resolved.participantId}`)!
  if (
    !handle ||
    handle.generation !== resolved.generation ||
    (input.generation && input.generation !== handle.generation)
  )
    throw new Error("Chat participant registration changed; retry the turn")
  input.signal?.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal?.reason)
  input.signal?.addEventListener("abort", abort, { once: true })
  const requestId = globalThis.crypto.randomUUID()
  const call = {
    handle,
    controller,
    sessionId: input.sessionId,
    text: "",
    onPart: input.onPart,
    pending: Promise.resolve(),
  }
  requests.set(requestId, call)
  try {
    const payload = {
      token: handle.respondToken,
      requestId,
      request: {
        prompt: input.prompt,
        command: undefined,
        references: [],
        toolReferences: [],
        sessionId: input.sessionId,
      },
      context: {
        history: (input.history ?? []).map((message) =>
          message.role === "user"
            ? { request: { prompt: message.content }, participant: handle.participantId }
            : {
                response: [{ kind: "markdown", value: message.content }],
                participant: message.participant ?? handle.participantId,
                result: message.result ?? {},
              }
        ),
      },
    }
    assertNoLeakingPiiDeep(handle.pluginId, "vscode.chat.respond", [payload])
    const result = await deps.callProvider(handle.pluginId, "respond", payload, controller.signal)
    await call.pending
    controller.signal.throwIfAborted()
    if (result != null && (typeof result !== "object" || Array.isArray(result)))
      throw new Error("Chat participant returned an invalid ChatResult")
    const details =
      result && typeof result === "object"
        ? (result as { errorDetails?: { message?: unknown } }).errorDetails
        : undefined
    if (details)
      throw new Error(
        typeof details.message === "string" && details.message
          ? details.message
          : "Chat participant returned an error"
      )
    const metadata =
      result && typeof result === "object" ? (result as { metadata?: unknown }).metadata : undefined

    return { text: call.text, ...(metadata !== undefined ? { metadata } : {}) }
  } finally {
    input.signal?.removeEventListener("abort", abort)
    requests.delete(requestId)
  }
}

/**
 * Drop every callback owned by `extensionId`, preserving stored user policy.
 * Called by the plugin manager during extension deactivate.
 */
export async function disposeAllParticipantsFor(extensionId: string): Promise<void> {
  const keys: string[] = []
  for (const [key, handle] of participants) {
    if (handle.pluginId === extensionId) keys.push(key)
  }
  for (const key of keys) {
    const handle = participants.get(key)
    if (!handle) continue
    abortParticipant(handle)
    participants.delete(key)
  }
}

export function __listParticipantsForTesting(): ParticipantHandle[] {
  return [...participants.values()]
}
