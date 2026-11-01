/**
 * Provider registry. Module-level map, duplicate ids replace (a plugin that
 * reloads re-registers), test reset clears. Same shape as
 * `lib/issues/sources/registry.ts` and `lib/issues/run/registry.ts`.
 */

import type { IssueSyncProvider } from "./types"

export class IssueSyncRegistry {
  private readonly providers = new Map<string, IssueSyncProvider>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  getRevision = (): number => this.revision
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(): void {
    this.revision += 1
    for (const listener of [...this.listeners]) listener()
  }

  signal(id: string, provider: IssueSyncProvider): AbortSignal {
    if (this.providers.get(id) !== provider) return AbortSignal.abort()
    return this.controllers.get(id)!.signal
  }

  register(provider: IssueSyncProvider): () => void {
    this.unregister(provider.id)
    this.providers.set(provider.id, provider)
    const controller = new AbortController()
    this.controllers.set(provider.id, controller)
    this.changed()
    return () => {
      if (this.controllers.get(provider.id) === controller) this.unregister(provider.id)
    }
  }

  unregister(id: string): void {
    if (!this.providers.delete(id)) return
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    this.changed()
  }

  get(id: string): IssueSyncProvider | undefined {
    return this.providers.get(id)
  }

  list(): IssueSyncProvider[] {
    return [...this.providers.values()]
  }
}

let singleton: IssueSyncRegistry | null = null

export function getIssueSyncRegistry(): IssueSyncRegistry {
  if (!singleton) singleton = new IssueSyncRegistry()
  return singleton
}

export function resetIssueSyncRegistry(): void {
  if (singleton) for (const provider of singleton.list()) singleton.unregister(provider.id)
}

export const subscribeIssueSyncProviders = (listener: () => void): (() => void) =>
  getIssueSyncRegistry().subscribe(listener)
export const getIssueSyncProvidersRevision = (): number => getIssueSyncRegistry().getRevision()

export function registerIssueSyncProvider(
  provider: IssueSyncProvider,
  registry: IssueSyncRegistry = getIssueSyncRegistry()
): () => void {
  return registry.register(provider)
}
