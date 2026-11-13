import { personalEgressToolDenied } from "@cognia/agent-contracts/personal-egress"

export interface PersonalEgressPolicy {
  personalEgressFenced?: boolean
  personalEgressReadTools?: string[]
  mcpServers?: Record<string, unknown>
  /** Shared by shallow runtime/agent overlays; never replaced within a session. */
  personalEgressState?: { fenced: boolean }
}

export function personalEgressState(policy: PersonalEgressPolicy): { fenced: boolean } {
  policy.personalEgressState ??= { fenced: policy.personalEgressFenced === true }
  if (policy.personalEgressFenced === true) policy.personalEgressState.fenced = true
  return policy.personalEgressState
}

export function fencePersonalEgress(policy: PersonalEgressPolicy): void {
  personalEgressState(policy).fenced = true
  policy.personalEgressFenced = true
}

// Installed by the native surface only after resolving user namespace collisions.
// State identity is shared across runtime overlays; wire/tool input cannot alter it.
const hostRegistries = new WeakMap<object, ReadonlySet<string>>()
export function bindPersonalEgressHostTools(
  policy: PersonalEgressPolicy,
  names: Iterable<string>
): void {
  hostRegistries.set(personalEgressState(policy), new Set(names))
}
function hostReadTools(policy: PersonalEgressPolicy): string[] {
  const registry = hostRegistries.get(personalEgressState(policy))
  return (policy.personalEgressReadTools ?? []).filter((name) =>
    registry
      ? registry.has(name)
      : !Object.prototype.hasOwnProperty.call(policy.mcpServers ?? {}, name.split("__")[1] ?? "")
  )
}
function hostSearch(policy: PersonalEgressPolicy, name: string): boolean {
  if (name !== "mcp__cognia-plugin-tools__web_search") return false
  const registry = hostRegistries.get(personalEgressState(policy))
  return registry
    ? registry.has(name)
    : !Object.prototype.hasOwnProperty.call(policy.mcpServers ?? {}, "cognia-plugin-tools")
}

export function personalToolDenied(
  name: string,
  policy: PersonalEgressPolicy,
  nativeRegistry: readonly string[] = []
): boolean {
  return personalEgressToolDenied(
    name,
    personalEgressState(policy).fenced,
    hostReadTools(policy),
    nativeRegistry.includes(name)
      ? { kind: "native", registeredTools: nativeRegistry }
      : hostSearch(policy, name)
        ? { kind: "host" }
        : { kind: "unknown" }
  )
}

const pending = new WeakMap<object, Map<Promise<void>, string | undefined>>()
const unprovenProcesses = new WeakMap<object, Set<Promise<void>>>()
const finishers = new WeakMap<object, Map<Promise<void>, { id?: string; finish(): void }>>()

/** Registered by runtime/tool wrappers, never by model arguments. */
export function beginPersonalEgressOperation(
  policy: PersonalEgressPolicy,
  processUnproven = false,
  toolUseId?: string
): () => void {
  const state = personalEgressState(policy)
  if (state.fenced) throw new Error("Personal egress is fenced")
  const work = pending.get(state) ?? new Map<Promise<void>, string | undefined>()
  pending.set(state, work)
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  work.set(done, toolUseId)
  if (processUnproven) {
    const processes = unprovenProcesses.get(state) ?? new Set<Promise<void>>()
    processes.add(done)
    unprovenProcesses.set(state, processes)
  }
  const release = () => {
    work.delete(done)
    unprovenProcesses.get(state)?.delete(done)
    finishers.get(state)?.delete(done)
    finish()
  }
  const entries = finishers.get(state) ?? new Map()
  entries.set(done, { id: toolUseId, finish: release })
  finishers.set(state, entries)
  return release
}

/** Runtime-owned terminal/denial cleanup, never exposed to tool input. */
export function releasePersonalEgressOperations(
  policy: PersonalEgressPolicy,
  toolUseId?: string
): void {
  for (const entry of [...(finishers.get(personalEgressState(policy))?.values() ?? [])])
    if (toolUseId === undefined || entry.id === toolUseId) entry.finish()
}

export function opaquePersonalTool(
  name: string,
  policy: PersonalEgressPolicy,
  nativeRegistry: readonly string[] = []
): boolean {
  return (
    /(?:sandbox_bash|start_process|shell_execute|terminal)/i.test(name) ||
    personalEgressToolDenied(
      name,
      true,
      hostReadTools(policy),
      nativeRegistry.includes(name)
        ? { kind: "native", registeredTools: nativeRegistry }
        : hostSearch(policy, name)
          ? { kind: "host" }
          : { kind: "unknown" }
    )
  )
}

/** Fence acknowledgement attests quiescence, not just a flag assignment. */
export async function quiescePersonalEgress(
  policy: PersonalEgressPolicy,
  excludedToolUseIds: readonly string[] = []
): Promise<void> {
  const state = personalEgressState(policy)
  const work = [...(pending.get(state) ?? [])]
    .filter(([, id]) => !id || !excludedToolUseIds.includes(id))
    .map(([done]) => done)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Personal egress operations did not settle; private content withheld")
            ),
          2000
        )
      }),
    ])
    if (unprovenProcesses.get(state)?.size)
      throw new Error("Personal process isolation unconfirmed; private content withheld")
  } finally {
    if (timer) clearTimeout(timer)
  }
}
