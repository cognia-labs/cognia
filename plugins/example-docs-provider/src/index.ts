import {
  defineDocsProvider,
  definePlugin,
  definePluginManifest,
  DocsProviderError,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)
const SERVICE = "auth.example-tracker"
const DOCS_ORIGIN = "https://docs.example-tracker.test"

/** Only an explicit connect command prompts; background reads never re-authorize a revoked grant. */
export async function requestAccess(ctx: Pick<PluginContext, "auth">): Promise<boolean> {
  const connection = await ctx.auth.connections.get({
    service: SERVICE,
    scopes: ["docs.read"],
    interactive: true,
  })
  return connection
    ? (
        await ctx.auth.connections.requestGrant(connection.ref, {
          operations: ["docs.request.GET"],
          scopes: ["docs.read"],
        })
      ).granted
    : false
}

export default definePlugin({
  manifest,
  async activate(ctx) {
    const registration = ctx.docsProviders.register(
      defineDocsProvider({
        id: "docs",
        mentionPrefix: "cognia-example-docs-provider.docs:",
        kinds: ["doc"],
        async listAccounts() {
          const connection = await ctx.auth.connections.get({
            service: SERVICE,
            scopes: ["docs.read"],
          })
          return connection
            ? [
                {
                  id: connection.ref,
                  label: connection.accountLabel,
                  authorizationEpoch: String(connection.revision),
                },
              ]
            : []
        },
        matchRef(input) {
          try {
            const url = new URL(input)
            const match = /^\/documents\/([a-zA-Z0-9_-]+)$/.exec(url.pathname)
            return url.origin === DOCS_ORIGIN && !url.username && !url.password && match
              ? { kind: "doc", id: match[1], url: `${DOCS_ORIGIN}${url.pathname}` }
              : null
          } catch {
            return null
          }
        },
        async fetch(ref, options) {
          const connection = await ctx.auth.connections.get({
            service: SERVICE,
            scopes: ["docs.read"],
          })
          if (!connection || connection.ref !== options.accountId)
            throw new DocsProviderError("notAuthorized")
          const account = (await ctx.integrations.listAccounts("docs")).find(
            (item) => item.connectionId === connection.ref
          )
          if (!account) throw new DocsProviderError("notAuthorized")
          const response = await ctx.integrations.authenticatedRequest<unknown>(
            account.id,
            `https://api.example-tracker.test/documents/${encodeURIComponent(ref.id)}`,
            { signal: options.signal }
          )
          if (response.status === 404) throw new DocsProviderError("notFound")
          if (response.status === 401) throw new DocsProviderError("notAuthorized")
          if (response.status === 403) throw new DocsProviderError("noPermission")
          if (response.status < 200 || response.status >= 300)
            throw new DocsProviderError("network")
          const doc = response.data as { title?: unknown; text?: unknown } | null
          if (!doc || typeof doc.title !== "string" || typeof doc.text !== "string")
            throw new DocsProviderError("network")
          return { ref, title: doc.title, text: doc.text, format: "markdown" }
        },
      })
    )
    return {
      onDisable: () => registration.unregister(),
      onUnload: () => registration.unregister(),
      async onCommand(command) {
        if (command !== "example-docs-connect") return false
        const granted = await requestAccess(ctx)
        return { handled: true, message: ctx.i18n.t(granted ? "access.granted" : "access.denied") }
      },
    }
  },
})
