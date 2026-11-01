import {
  validateBackupDestinationDeclaration,
  type BackupDestinationContribution,
  type BackupDestinationDeclaration,
  type BackupDestinationBody,
  type PluginBackupDestinationId,
} from "@cognia/plugin-contract/types/plugin/plugin-backup-destinations"
import type { BackupDestination } from "@/types/scheduler"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import {
  bindPluginCallbacks,
  HOST_BACKGROUND,
  pluginDispatchContext,
  withPluginExecutionContext,
} from "@/lib/plugin/core/invocation-identity"

export interface RegisteredBackupDestination extends BackupDestinationContribution {
  id: BackupDestination
  pluginId?: string
  /** Host-only opt-in flags for legacy interval schedules; never passed to plugins. */
  intervalEnabled?: (settings: import("@cognia/agent-config-types").AppSettings) => boolean
  /** Host invocation proof is passed only to built-ins, never plugin callbacks. */
  readiness(
    signal: AbortSignal,
    credentialContext?: PersonalCredentialContext
  ): ReturnType<BackupDestinationContribution["readiness"]>
  list?(
    signal: AbortSignal,
    credentialContext?: PersonalCredentialContext
  ): ReturnType<NonNullable<BackupDestinationContribution["list"]>>
  download?(
    remoteId: string,
    signal: AbortSignal,
    credentialContext?: PersonalCredentialContext
  ): ReturnType<NonNullable<BackupDestinationContribution["download"]>>
  upload(
    input: Parameters<BackupDestinationContribution["upload"]>[0],
    signal: AbortSignal,
    assertActive?: () => void,
    credentialContext?: PersonalCredentialContext
  ): ReturnType<BackupDestinationContribution["upload"]>
}

const entries = new Map<string, { value: RegisteredBackupDestination; lifetime: AbortController }>()
const listeners = new Set<() => void>()
let revision = 0

function changed() {
  revision++
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* A subscriber cannot prevent registration or teardown. */
    }
  }
}

export const getBackupDestinationRevision = () => revision
export const subscribeBackupDestinations = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const listBackupDestinations = (): RegisteredBackupDestination[] =>
  [...entries.values()].map((entry) => entry.value)
export const getBackupDestination = (id: string) => entries.get(id)?.value

/** Cross-realm byte arrays and streams share one cancellable ciphertext reader. */
export async function readBackupDestinationBody(
  body: BackupDestinationBody,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  if (Object.prototype.toString.call(body) === "[object Uint8Array]") return body as Uint8Array
  if (!body || typeof (body as ReadableStream<Uint8Array>).getReader !== "function")
    throw new Error("Invalid backup ciphertext body")
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      if (Object.prototype.toString.call(value) !== "[object Uint8Array]")
        throw new Error("Invalid backup ciphertext chunk")
      chunks.push(value)
      length += value.byteLength
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}

/** Plugin ownership and declarations are checked even for callers below ctx.backup. */
export function registerBackupDestination(
  contribution: BackupDestinationContribution &
    Pick<RegisteredBackupDestination, "intervalEnabled">,
  owner?: { pluginId: string; declarations: readonly BackupDestinationDeclaration[] }
): () => void {
  let id: BackupDestination
  if (owner) {
    const errors = validateBackupDestinationDeclaration(contribution)
    if (errors.length) throw new Error(errors.join("; "))
    if (!owner.pluginId || /[/:]/.test(owner.pluginId))
      throw new Error("Invalid backup destination plugin id")
    const declared = owner.declarations.find((def) => def.id === contribution.id)
    if (!declared || declared.label !== contribution.label)
      throw new Error("Backup destination must be declared in manifest.backupDestinations")
    id = `plugin:${owner.pluginId}/${contribution.id}` as PluginBackupDestinationId
  } else {
    if (!["webdav", "github", "googledrive"].includes(contribution.id))
      throw new Error("Unknown built-in backup destination")
    id = contribution.id as BackupDestination
  }
  if (entries.has(id)) throw new Error(`Backup destination ${id} is already registered`)
  for (const method of ["readiness", "upload"] as const)
    if (typeof contribution[method] !== "function")
      throw new Error(`Backup destination requires ${method}`)
  for (const method of ["list", "download", "delete"] as const)
    if (contribution[method] !== undefined && typeof contribution[method] !== "function")
      throw new Error(`Invalid backup destination ${method}`)
  const callbacks = owner
    ? {
        ...bindPluginCallbacks(owner.pluginId, contribution),
        ...(contribution.list
          ? {
              list: (signal: AbortSignal, context?: PersonalCredentialContext) =>
                withPluginExecutionContext(
                  owner.pluginId,
                  context ?? pluginDispatchContext(owner.pluginId),
                  () => contribution.list!(signal)
                ),
            }
          : {}),
        ...(contribution.download
          ? {
              download: (
                remoteId: string,
                signal: AbortSignal,
                context?: PersonalCredentialContext
              ) =>
                withPluginExecutionContext(
                  owner.pluginId,
                  context ?? pluginDispatchContext(owner.pluginId),
                  () => contribution.download!(remoteId, signal)
                ),
            }
          : {}),
        readiness: (signal: AbortSignal, context?: PersonalCredentialContext) =>
          withPluginExecutionContext(
            owner.pluginId,
            context ?? pluginDispatchContext(owner.pluginId),
            () => contribution.readiness(signal)
          ),
        upload: (
          input: Parameters<RegisteredBackupDestination["upload"]>[0],
          signal: AbortSignal,
          _assertActive?: () => void,
          context?: PersonalCredentialContext
        ) =>
          withPluginExecutionContext(
            owner.pluginId,
            context ?? pluginDispatchContext(owner.pluginId),
            () => contribution.upload(input, signal)
          ),
      }
    : contribution
  const entry = {
    value: Object.freeze({ ...callbacks, id, ...(owner ? { pluginId: owner.pluginId } : {}) }),
    lifetime: new AbortController(),
  }
  entries.set(id, entry)
  changed()
  return () => {
    if (entries.get(id) !== entry) return
    entries.delete(id)
    entry.lifetime.abort()
    changed()
  }
}

/** Race abort as well as checking afterwards: an uncooperative late result cannot commit. */
export async function withBackupDestination<T>(
  id: string,
  signal: AbortSignal | undefined,
  invoke: (entry: RegisteredBackupDestination, signal: AbortSignal) => Promise<T>,
  credentialContext?: PersonalCredentialContext
): Promise<T> {
  const entry = entries.get(id)
  if (!entry) throw new Error("destination unavailable on this runtime")
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  entry.lifetime.signal.addEventListener("abort", abort, { once: true })
  if (signal?.aborted || entry.lifetime.signal.aborted) abort()
  let onAbort: () => void = () => undefined
  try {
    controller.signal.throwIfAborted()
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException("Backup cancelled", "AbortError"))
      controller.signal.addEventListener("abort", onAbort, { once: true })
    })
    const pluginId = entry.value.pluginId
    const context = credentialContext ?? HOST_BACKGROUND
    const work = () =>
      invoke(
        pluginId ? bindPluginCallbacks(pluginId, entry.value, () => context) : entry.value,
        controller.signal
      )
    const pending = pluginId ? withPluginExecutionContext(pluginId, context, work) : work()
    const result = await Promise.race([pending, aborted])
    controller.signal.throwIfAborted()
    return result
  } finally {
    signal?.removeEventListener("abort", abort)
    entry.lifetime.signal.removeEventListener("abort", abort)
    controller.signal.removeEventListener("abort", onAbort)
  }
}
