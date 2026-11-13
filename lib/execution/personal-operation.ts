/** Host-only opaque operation lineage. Symbols survive Host context spreads;
 * JSON/tool input cannot mint a token or recover its private parent links. */
const OPERATION = Symbol("Host personal operation")
type Token = Readonly<Record<never, never>>
interface Origin {
  sessionId: string
  toolUseId: string
  scope: string
}
interface Facts {
  parent?: Token
  origin?: Origin
}
const facts = new WeakMap<Token, Facts>()
type Bound = { [OPERATION]?: Token }
export function personalOperation(context: object | undefined): Token | undefined {
  const token = (context as Bound | undefined)?.[OPERATION]
  return token && facts.has(token) ? token : undefined
}
export function bindPersonalOperationOrigin<T extends object>(context: T, origin: Origin): T {
  const token = Object.freeze({})
  facts.set(token, { parent: personalOperation(context), origin })
  Object.defineProperty(context, OPERATION, { value: token, enumerable: true, configurable: true })
  return context
}
export function forkPersonalOperation<T extends object>(context: T): T {
  const bound = copyPersonalOperation(context, { ...context })
  const token = Object.freeze({})
  facts.set(token, { parent: personalOperation(context) })
  Object.defineProperty(bound, OPERATION, { value: token, enumerable: true, configurable: true })
  return bound
}
function ancestor(ancestorToken: Token | undefined, token: Token | undefined): boolean {
  if (!ancestorToken) return false
  for (let i = 0; token && i < 128; i++, token = facts.get(token)?.parent)
    if (ancestorToken === token) return true
  return false
}
// Additional producer dependencies are Host-only and do not grant credential authority.
const producerSources = new WeakMap<object, readonly object[]>()
const copiedProducerSources = new WeakMap<object, object>()
export function bindPersonalOperationSources<T extends object>(
  context: T,
  sources: readonly object[]
): T {
  producerSources.set(context, sources)
  return context
}
export function personalOperationSources(context: object): readonly object[] | undefined {
  return producerSources.get(context)
}
/** The actual admission context identifies its stream; siblings remain tracked. */
export function isPersonalAdmissionOperation(operation: object, admission?: object): boolean {
  const work = personalOperation(operation),
    current = personalOperation(admission)
  return ancestor(work, current)
}
export function copyPersonalOperation<T extends object>(source: object, target: T): T {
  const sources = producerSources.get(source)
  if (sources) {
    producerSources.set(target, sources)
    copiedProducerSources.set(target, copiedProducerSources.get(source) ?? source)
  }
  const token = personalOperation(source)
  if (token)
    Object.defineProperty(target, OPERATION, { value: token, enumerable: true, configurable: true })
  return target
}
/** Select only a unique most-specific Host operation, never a concurrent sibling. */
export function mostSpecificPersonalOperation(contexts: readonly object[]): object | undefined {
  return [...contexts]
    .reverse()
    .find((candidate) =>
      contexts.every(
        (other) =>
          !personalOperation(other) ||
          ancestor(personalOperation(other), personalOperation(candidate))
      )
    )
}
export function personalOperationToolIds(
  context: object | undefined,
  sessionId: string,
  scope: string
): string[] {
  const ids = new Set<string>()
  for (
    let token = personalOperation(context), depth = 0;
    token && depth < 128;
    token = facts.get(token)?.parent, depth++
  ) {
    const origin = facts.get(token)?.origin
    if (origin?.sessionId === sessionId && origin.scope === scope) ids.add(origin.toolUseId)
  }
  return [...ids]
}
export function personalOperationScope(remote?: {
  hostId: string
  originDeviceId: string
  generation: number
}): string {
  return remote
    ? JSON.stringify([remote.hostId, remote.originDeviceId, remote.generation])
    : "local"
}

const failureSources = new WeakMap<object, object>()
/** Normalize non-Error plugin throws at the Host boundary and retain their producer. */
export function retainPersonalFailure(error: unknown, source: object): Error {
  const failure =
    error instanceof Error
      ? error
      : Object.assign(
          new Error(typeof error === "string" ? error : "Plugin callback failed", { cause: error }),
          error && typeof error === "object" ? error : {}
        )
  const previous = failureSources.get(failure)
  failureSources.set(
    failure,
    previous ? bindPersonalOperationSources({}, [previous, source]) : source
  )
  return failure
}
export function personalFailureSource(error: unknown): object | undefined {
  return error && typeof error === "object" ? failureSources.get(error) : undefined
}

// A dependency-free seam keeps synchronous contribution delivery from importing
// Dexie during module evaluation. The canonical egress owner installs its cache.
let dispatchFence: ((context: object) => boolean | undefined) | undefined
export function configurePersonalDispatchFence(
  read: (context: object) => boolean | undefined
): () => void {
  const previous = dispatchFence
  dispatchFence = read
  return () => {
    dispatchFence = previous
  }
}
export function cachedPersonalDispatchFence(context: object): boolean | undefined {
  const row = context as {
    executionRunId?: string
    personalEgressBlocked?: true
    personalSources?: object[]
    sessionDerived?: true
  }
  if (
    !row.executionRunId &&
    !row.sessionDerived &&
    !row.personalEgressBlocked &&
    !row.personalSources?.length &&
    !personalOperationSources(context)?.length
  )
    return false
  const cached = dispatchFence?.(context)
  const original = copiedProducerSources.get(context)
  return cached ?? (original ? dispatchFence?.(original) : undefined)
}
