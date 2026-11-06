/**
 * Remote document provider registry — one registration per provider.
 *
 * Module-level map, duplicate registration throws. Same shape as
 * `lib/chat/mentions/pick-registry.ts` and `lib/plugin/registries/*`,
 * deliberately: adding a document source is a `registerDocsProvider` call (a
 * plugin's, through `ctx.docsProviders`) or a module providing the
 * `docs-provider` collection port, never an edit to the composer.
 *
 * The built-ins are the port's members (`types/modules/ports/docs-provider.ts`):
 * Google Docs and Lark Docs are modules of their own that this framework never
 * imports. The first read of the registry starts loading them, and each one
 * registers as it arrives, so a subscriber (`useDocsProviders`) re-renders
 * when they do. A caller that must see them before acting (an OAuth callback,
 * a kept copy's source, a rehydrated dock tab) awaits
 * `whenDocsProvidersReady()` first. What has to hold before any of them loads,
 * each built-in's document URL scheme, stays in the synchronous catalog
 * `./providers/_document-urls.ts`.
 */

import { detectPlatform } from "@/lib/platform/detect"
import { loadPortCollection } from "@/lib/modules/ports"
import { BUILTIN_DOCUMENT_URLS } from "./providers/_document-urls"
import { loggers } from "@cognia/logging"
import type { DocsProvider } from "./types"

const providers = new Map<string, DocsProvider>()
const listeners = new Set<() => void>()
const requests = new Map<DocsProvider, Set<AbortController>>()
const accountListeners = new Map<DocsProvider, Set<() => void>>()
let revision = 0
/** The built-in load in flight or done, or `null` before the first read and after a failure. */
let builtins: Promise<void> | null = null
/** Bumped by a test clear, so a load that started before it registers nothing. */
let builtinGeneration = 0
/** Set by a test clear: suites that register only stubs never see the built-ins. */
let builtinsSuppressed = false

export function getDocsProvidersRevision(): number {
  ensureBuiltinDocsProviders()
  return revision
}

export function subscribeDocsProviders(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function changed(): void {
  revision += 1
  for (const listener of [...listeners]) notify(listener)
}

function notify(listener: () => void): void {
  try {
    listener()
  } catch (error) {
    loggers.chat.warn("Document provider listener failed", { error })
  }
}

function abortError(): Error {
  return new DOMException("Document provider is no longer available", "AbortError")
}

/** Published functions belong to one registration, including functions retained by a consumer. */
function managedProvider(source: DocsProvider): DocsProvider {
  const provider: DocsProvider = { ...source }
  const run = async <T>(
    signal: AbortSignal | undefined,
    read: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const controller = new AbortController()
    const untrack = trackDocsProviderRequest(provider, controller)
    const abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    try {
      if (controller.signal.aborted) throw abortError()
      return await new Promise<T>((resolve, reject) => {
        const cancelled = () => reject(abortError())
        controller.signal.addEventListener("abort", cancelled, { once: true })
        void Promise.resolve()
          .then(() => {
            if (controller.signal.aborted) throw abortError()
            return read(controller.signal)
          })
          .then((value) => {
            if (controller.signal.aborted || providers.get(provider.id) !== provider)
              reject(abortError())
            else resolve(value)
          }, reject)
          .finally(() => controller.signal.removeEventListener("abort", cancelled))
      })
    } finally {
      signal?.removeEventListener("abort", abort)
      untrack()
    }
  }
  provider.listAccounts = (options) => run(undefined, () => source.listAccounts(options))
  provider.matchRef = (input) => {
    if (providers.get(provider.id) !== provider) return null
    try {
      return source.matchRef(input)
    } catch (error) {
      loggers.chat.warn("Document provider recognition failed", { providerId: provider.id, error })
      return null
    }
  }
  provider.fetch = (ref, options) =>
    run(options.signal, (signal) => source.fetch(ref, { ...options, signal }))
  if (source.search)
    provider.search = (query, options) =>
      run(options.signal, (signal) => source.search!(query, { ...options, signal }))
  if (source.subscribeAccounts)
    provider.subscribeAccounts = (listener) => {
      if (providers.get(provider.id) !== provider) return () => {}
      let stopSource: () => void
      try {
        stopSource = source.subscribeAccounts!(() => {
          if (providers.get(provider.id) === provider) notify(listener)
        })
      } catch (error) {
        loggers.chat.warn("Document provider account subscription failed", {
          providerId: provider.id,
          error,
        })
        return () => {}
      }
      const active = accountListeners.get(provider) ?? new Set<() => void>()
      let listening = true
      const stop = () => {
        if (!listening) return
        listening = false
        active.delete(stop)
        notify(stopSource)
      }
      active.add(stop)
      accountListeners.set(provider, active)
      return stop
    }
  return provider
}

/** Fence requests even before React has rendered a registry notification. */
export function trackDocsProviderRequest(
  provider: DocsProvider,
  controller: AbortController
): () => void {
  if (providers.get(provider.id) !== provider) {
    controller.abort()
    return () => {}
  }
  const active = requests.get(provider) ?? new Set<AbortController>()
  active.add(controller)
  requests.set(provider, active)
  return () => {
    active.delete(controller)
    if (!active.size) requests.delete(provider)
  }
}

export function registerDocsProvider(provider: DocsProvider): () => void {
  if (providers.has(provider.id)) {
    throw new Error(`docs provider "${provider.id}" already registered`)
  }
  if (!provider.mentionPrefix.endsWith(":")) {
    throw new Error(
      `docs provider "${provider.id}" mentionPrefix must end with ":" (got "${provider.mentionPrefix}")`
    )
  }
  for (const other of providers.values()) {
    if (other.mentionPrefix === provider.mentionPrefix) {
      throw new Error(
        `docs provider "${provider.id}" claims mention prefix "${provider.mentionPrefix}" already used by "${other.id}"`
      )
    }
  }
  const published = managedProvider(provider)
  providers.set(provider.id, published)
  changed()
  return () => {
    if (providers.get(provider.id) === published) unregisterDocsProvider(provider.id)
  }
}

/** Remove one dynamically contributed provider. Built-ins are never removed in production. */
export function unregisterDocsProvider(id: string): boolean {
  const provider = providers.get(id)
  if (!provider) return false
  providers.delete(id)
  for (const controller of requests.get(provider) ?? []) controller.abort()
  requests.delete(provider)
  for (const stop of [...(accountListeners.get(provider) ?? [])]) notify(stop)
  accountListeners.delete(provider)
  changed()
  return true
}

/**
 * Register every member of the `docs-provider` port that is not registered
 * yet. A member whose module failed to load is logged and tried again by the
 * next `whenDocsProvidersReady()`; the others still register.
 */
function loadBuiltinDocsProviders(): Promise<void> {
  const generation = builtinGeneration
  const load = loadPortCollection("docs-provider").then(({ members, failures }) => {
    if (generation !== builtinGeneration || builtinsSuppressed) return
    // The URL catalog's order, which is the order people have always seen.
    const rank = (id: string) => {
      const index = BUILTIN_DOCUMENT_URLS.findIndex((scheme) => scheme.providerId === id)
      return index < 0 ? BUILTIN_DOCUMENT_URLS.length : index
    }
    const ordered = [...members].sort((a, b) => rank(a.port.id) - rank(b.port.id))
    for (const { module: moduleId, port } of ordered) {
      // A provider survives a dependency reload with its active reads.
      if (providers.has(port.id)) continue
      try {
        registerDocsProvider(port)
      } catch (error) {
        loggers.chat.warn("Built-in document provider rejected", { module: moduleId, error })
      }
    }
    for (const { module: moduleId, error } of failures)
      loggers.chat.warn("Built-in document provider failed to load", { module: moduleId, error })
    if (failures.length && builtins === load) builtins = null
  })
  builtins = load
  return load
}

function ensureBuiltinDocsProviders(): void {
  if (!builtins && !builtinsSuppressed) void loadBuiltinDocsProviders()
}

/**
 * Resolves once every built-in provider that can load has registered. Never
 * rejects: a member that failed is logged, and the call after tries it again.
 */
export function whenDocsProvidersReady(): Promise<void> {
  if (builtinsSuppressed) return Promise.resolve()
  return builtins ?? loadBuiltinDocsProviders()
}

/** The provider `id`, after the built-ins have had their chance to register. */
export async function resolveDocsProvider(id: string): Promise<DocsProvider | undefined> {
  await whenDocsProvidersReady()
  return providers.get(id)
}

export function getDocsProvider(id: string): DocsProvider | undefined {
  ensureBuiltinDocsProviders()
  return providers.get(id)
}

/** Every registered provider, in registration order. */
export function listDocsProviders(): DocsProvider[] {
  ensureBuiltinDocsProviders()
  return [...providers.values()]
}

/**
 * Providers that can actually run on this host. The picker and the settings
 * cards both key off this — everything else stays visible but inert, so a
 * mobile user sees WHY the feature is missing instead of an empty list.
 */
export function listAvailableDocsProviders(): DocsProvider[] {
  const platform = detectPlatform()
  return listDocsProviders().filter((p) => p.hosts.includes(platform))
}

/** True when `provider` can run on this host. */
export function isDocsProviderHostSupported(provider: DocsProvider): boolean {
  return provider.hosts.includes(detectPlatform())
}

/**
 * `{ prefix, providerId }` for every registered provider — consumed by
 * `detectTrigger` to turn `@lark:` into a typed trigger. Returned for ALL
 * providers, not just host-supported ones: the trigger must still fire on an
 * unsupported host so the panel can explain itself.
 */
export function docsProviderPrefixes(): { prefix: string; providerId: string }[] {
  return listDocsProviders().map((p) => ({ prefix: p.mentionPrefix, providerId: p.id }))
}

/** Resolve the provider owning a namespace prefix (`"lark:"`). */
export function getDocsProviderByPrefix(prefix: string): DocsProvider | undefined {
  return listDocsProviders().find((p) => p.mentionPrefix === prefix)
}

/**
 * Test-only: drop every registration, and keep the built-ins out until
 * `__resetDocsProvidersForTests` (from `./index`) brings them back. For suites
 * that register only stubs.
 */
export function __clearDocsProvidersForTests(): void {
  builtinGeneration += 1
  builtinsSuppressed = true
  builtins = null
  for (const id of [...providers.keys()]) unregisterDocsProvider(id)
}

/** Test-only: exactly the built-in set, registered. */
export async function __resetDocsProvidersForTests(): Promise<void> {
  __clearDocsProvidersForTests()
  builtinsSuppressed = false
  await loadBuiltinDocsProviders()
}
