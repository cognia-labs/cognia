/** Public plugin document contributions. Credentials remain behind the connection API. */
import type { PluginManifest } from "@cognia/plugin-contract/types/plugin/plugin"
import type { PluginAuthConnectionsAPI } from "@cognia/plugin-contract/lib/plugin/api/auth-api"
import {
  DocsProviderError,
  validatePluginDocsProviderDef,
  type PluginDocsProvider,
  type PluginDocsProviderDef,
  type PluginDocsProvidersAPI,
  type PluginDocsProviderRegistration,
} from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"
import {
  registerDocsProvider,
  type DocsProvider,
  type DocsProviderCallOptions,
} from "@/lib/docs-providers"
import { detectPlatform } from "@/lib/platform/detect"
import { createAuthConnectionsAPI } from "@/lib/plugin/auth/connections-api"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { loggers } from "@cognia/logging"
import {
  bindPluginCallbacks,
  HOST_BACKGROUND,
  withPluginExecutionContext,
} from "../core/invocation-identity"

const declarations = new Map<string, readonly PluginDocsProviderDef[]>()
const registrations = new Map<string, Set<() => void>>()
const activations = new Map<string, symbol>()

/** The manifest contributes descriptors; implementations arrive through ctx.docsProviders.register. */
export function registerDocsProviderDeclarationsForPlugin(manifest: PluginManifest): void {
  const defs = manifest.docsProviders ?? []
  const ids = new Set<string>()
  const prefixes = new Set<string>()
  for (const def of defs) {
    const errors = validatePluginDocsProviderDef(def, manifest.id)
    if (errors.length) throw new Error(errors.join("; "))
    if (ids.has(def.id) || prefixes.has(def.mentionPrefix))
      throw new Error("Duplicate docs provider descriptor")
    ids.add(def.id)
    prefixes.add(def.mentionPrefix)
  }
  declarations.set(
    manifest.id,
    defs.map((def) => ({ ...def, kinds: [...def.kinds], urlOrigins: [...def.urlOrigins] }))
  )
}

export function clearDocsProvidersForPlugin(pluginId: string): void {
  activations.delete(pluginId)
  declarations.delete(pluginId)
  for (const dispose of [...(registrations.get(pluginId) ?? [])]) {
    try {
      dispose()
    } catch (error) {
      loggers.chat.warn("Document provider cleanup failed", { pluginId, error })
    }
  }
  registrations.delete(pluginId)
}

export interface PluginDocsProvidersRuntime {
  connections: Pick<PluginAuthConnectionsAPI, "list" | "onDidChange">
  hasPermission: (permission: string) => boolean
  subscribePermissions?: (listener: () => void) => () => void
}

export function createDocsProvidersAPI(
  pluginId: string,
  manifest: PluginManifest,
  runtime?: PluginDocsProvidersRuntime
): PluginDocsProvidersAPI {
  const hasPermission =
    runtime?.hasPermission ??
    ((permission: string) => getPermissionGuard().check(pluginId, permission as "docs:provide"))
  const connections = runtime?.connections ?? createAuthConnectionsAPI(pluginId, hasPermission)
  const subscribePermissions =
    runtime?.subscribePermissions ??
    (runtime
      ? undefined
      : (listener: () => void) => getPermissionGuard().subscribePermissionChanges(listener))
  clearDocsProvidersForPlugin(pluginId)
  registerDocsProviderDeclarationsForPlugin(manifest)
  const activation = Symbol(pluginId)
  activations.set(pluginId, activation)
  return {
    register(implementation: PluginDocsProvider): PluginDocsProviderRegistration {
      if (!hasPermission("docs:provide"))
        throw new Error("Permission denied: docs:provide is required")
      if (activations.get(pluginId) !== activation)
        throw new Error("Docs provider activation is no longer available")
      const input = { ...implementation }
      const def = declarations.get(pluginId)?.find((candidate) => candidate.id === input?.id)
      if (!def) throw new Error("Docs provider must be declared in manifest.docsProviders")
      if (
        !input ||
        typeof input.matchRef !== "function" ||
        typeof input.fetch !== "function" ||
        typeof input.listAccounts !== "function" ||
        (input.search !== undefined && typeof input.search !== "function") ||
        (input.subscribeAccounts !== undefined && typeof input.subscribeAccounts !== "function") ||
        input.mentionPrefix !== def.mentionPrefix ||
        JSON.stringify(input.kinds) !== JSON.stringify(def.kinds)
      ) {
        throw new Error("Docs provider implementation does not match its manifest descriptor")
      }
      const providerId = `plugin:${pluginId}/${def.id}`
      const activeReads = new Set<AbortController>()
      let active = true
      const check = () => {
        if (!active || activations.get(pluginId) !== activation || !hasPermission("docs:provide"))
          throw new DocsProviderError("notConfigured")
      }
      const listAccounts = async (options?: Pick<DocsProviderCallOptions, "credentialContext">) => {
        check()
        const [offered, available] = await Promise.all([
          withPluginExecutionContext(pluginId, options?.credentialContext ?? HOST_BACKGROUND, () =>
            input.listAccounts()
          ),
          connections.list(),
        ])
        check()
        return offered.flatMap((account) => {
          const connection = available.find(
            (row) =>
              row.ref === account.id &&
              row.status === "connected" &&
              String(row.revision) === account.authorizationEpoch
          )
          return connection
            ? [
                {
                  id: connection.ref,
                  label: connection.accountLabel,
                  authorizationEpoch: String(connection.revision),
                  ...(account.searchable === false ? { searchable: false } : {}),
                },
              ]
            : []
        })
      }
      const verify = async (options: DocsProviderCallOptions) => {
        const accounts = await listAccounts(options)
        if (
          !accounts.some(
            (account) =>
              account.id === options.accountId &&
              account.authorizationEpoch === options.expectedAuthorizationEpoch
          )
        )
          throw new DocsProviderError("notAuthorized")
      }
      const read = async <T>(
        options: DocsProviderCallOptions,
        invoke: (signal: AbortSignal) => Promise<T>
      ): Promise<T> => {
        const controller = new AbortController()
        const abort = () => controller.abort()
        options.signal?.addEventListener("abort", abort, { once: true })
        if (options.signal?.aborted) abort()
        activeReads.add(controller)
        try {
          await verify(options)
          if (controller.signal.aborted) throw new DOMException("Read aborted", "AbortError")
          const value = await withPluginExecutionContext(
            pluginId,
            options.credentialContext ?? HOST_BACKGROUND,
            () => invoke(controller.signal)
          )
          await verify(options)
          if (controller.signal.aborted) throw new DOMException("Read aborted", "AbortError")
          return value
        } finally {
          options.signal?.removeEventListener("abort", abort)
          activeReads.delete(controller)
        }
      }
      const stopConnections = connections.onDidChange(() => {
        for (const controller of activeReads) controller.abort()
      })
      const ownsUrl = (raw: string) => {
        try {
          const url = new URL(raw.trim())
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !/^https:\/\/[^/?#]*@/i.test(raw.trim()) &&
            def.urlOrigins.includes(url.origin)
          )
        } catch {
          return false
        }
      }
      const matchRef: DocsProvider["matchRef"] = (raw) => {
        if (!active || activations.get(pluginId) !== activation || !hasPermission("docs:provide"))
          return null
        if (!ownsUrl(raw)) return null
        const matched = withPluginExecutionContext(pluginId, HOST_BACKGROUND, () =>
          input.matchRef(raw)
        )
        return matched &&
          def.kinds.includes(matched.kind) &&
          matched.id &&
          (!matched.url || ownsUrl(matched.url))
          ? {
              kind: matched.kind,
              id: matched.id,
              url: matched.url ?? new URL(raw.trim()).href,
              ...(matched.sourceType ? { sourceType: matched.sourceType } : {}),
              ...(matched.sublabel ? { sublabel: matched.sublabel } : {}),
              ...(matched.updatedAtMs !== undefined ? { updatedAtMs: matched.updatedAtMs } : {}),
            }
          : null
      }
      const validRef = (ref: { kind: string; id: string; url?: string }) => {
        if (!ref.id || !def.kinds.includes(ref.kind as PluginDocsProviderDef["kinds"][number]))
          return false
        if (!ref.url) return true
        const matched = matchRef(ref.url)
        return matched?.id === ref.id && matched.kind === ref.kind
      }
      const provider: DocsProvider = {
        id: providerId,
        label: def.label,
        mentionPrefix: def.mentionPrefix,
        kinds: [...def.kinds],
        urlOrigins: [...def.urlOrigins],
        hosts: [detectPlatform()],
        listAccounts,
        subscribeAccounts(listener) {
          check()
          const stopHost = connections.onDidChange(listener)
          try {
            const stopPlugin = bindPluginCallbacks(pluginId, input.subscribeAccounts)?.(listener)
            return () => {
              try {
                stopPlugin?.()
              } finally {
                stopHost()
              }
            }
          } catch (error) {
            stopHost()
            throw error
          }
        },
        matchRef,
        ...(input.search
          ? {
              search: (query, options) =>
                read(options, async (signal) => {
                  const hits = await input.search!(query, {
                    accountId: options.accountId,
                    expectedAuthorizationEpoch: options.expectedAuthorizationEpoch,
                    limit: options.limit,
                    signal,
                  })
                  return hits.map((ref) => {
                    if (!validRef(ref)) throw new DocsProviderError("invalidRef")
                    return { ...ref, providerId }
                  })
                }),
            }
          : {}),
        fetch(ref, options) {
          if (ref.providerId !== providerId || !validRef(ref))
            throw new DocsProviderError("invalidRef")
          return read(options, async (signal) => {
            const content = await input.fetch(ref, {
              accountId: options.accountId,
              expectedAuthorizationEpoch: options.expectedAuthorizationEpoch,
              signal,
            })
            if (
              content.ref.id !== ref.id ||
              content.ref.kind !== ref.kind ||
              !validRef(content.ref)
            )
              throw new DocsProviderError("invalidRef")
            return {
              ...content,
              ref: {
                ...content.ref,
                providerId,
                ...(ref.accountBinding ? { accountBinding: ref.accountBinding } : {}),
              },
            }
          })
        },
      }
      let disposeProvider: () => void
      try {
        disposeProvider = registerDocsProvider(provider)
      } catch (error) {
        stopConnections()
        throw error
      }
      const owned = registrations.get(pluginId) ?? new Set<() => void>()
      const unregister = () => {
        if (!active) return
        active = false
        for (const controller of activeReads) controller.abort()
        try {
          disposeProvider()
        } finally {
          try {
            stopConnections()
          } finally {
            stopPermissions?.()
            owned.delete(unregister)
          }
        }
      }
      owned.add(unregister)
      registrations.set(pluginId, owned)
      const stopPermissions = subscribePermissions?.(() => {
        if (!hasPermission("docs:provide") || !hasPermission("auth:consume")) unregister()
      })
      return { providerId, unregister }
    },
  }
}
