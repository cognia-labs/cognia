import {
  defineIssueSyncProvider,
  definePlugin,
  definePluginManifest,
  DocsProviderError,
  type PluginContext,
} from "@cognia/plugin-sdk"
import type { IssueStatus } from "@cognia/plugin-sdk/api/issues"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)
const statuses: IssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"]
const defaults = { open: "todo", closed: "done" }

function configOf(config: Record<string, unknown>) {
  const mapping = config.mapping as Record<string, unknown> | undefined
  if (
    typeof config.projectKey !== "string" ||
    !/^[A-Z][A-Z0-9_-]{1,31}$/.test(config.projectKey) ||
    !mapping ||
    !statuses.includes(mapping.open as IssueStatus) ||
    !statuses.includes(mapping.closed as IssueStatus)
  )
    throw new Error("Invalid Example Tracker resource configuration")
  return {
    projectKey: config.projectKey,
    mapping: mapping as { open: IssueStatus; closed: IssueStatus },
  }
}

export async function requestAccess(ctx: Pick<PluginContext, "auth">): Promise<boolean> {
  const connection = await ctx.auth.connections.get({
    service: "auth.example-tracker",
    scopes: ["issues.read"],
    interactive: true,
  })
  return connection
    ? (
        await ctx.auth.connections.requestGrant(connection.ref, {
          operations: ["issues.request.GET"],
          scopes: ["issues.read"],
        })
      ).granted
    : false
}

export default definePlugin({
  manifest,
  async activate(ctx) {
    let dispose = () => {}
    const register = async () => {
      const boundConnection = await ctx.auth.connections.get({
        service: "auth.example-tracker",
        scopes: ["issues.read"],
      })
      dispose()
      dispose = ctx.issues.registerSyncProvider(
        defineIssueSyncProvider({
          id: "issues",
          ...(boundConnection ? { connectionRef: boundConnection.ref } : {}),
          label: "Example Tracker Issues",
          pullFields: ["title", "description", "status"],
          pushFields: [],
          resource: {
            label: "Example Tracker Issues",
            schemaVersion: 2,
            schema: {
              type: "object",
              properties: { projectKey: { type: "string", title: "Project key", minLength: 2 } },
              required: ["projectKey"],
              mapping: {
                type: "object",
                properties: {
                  open: { type: "string", title: "Open status", enum: statuses, default: "todo" },
                  closed: {
                    type: "string",
                    title: "Closed status",
                    enum: statuses,
                    default: "done",
                  },
                },
                required: ["open", "closed"],
              },
            },
            describe(config) {
              const { projectKey } = configOf(config)
              return { key: projectKey, label: projectKey }
            },
            validate(config) {
              try {
                configOf(config)
                return []
              } catch {
                return ["Invalid project key or status mapping"]
              }
            },
            migrate(fromVersion, config) {
              if (fromVersion !== 1) throw new Error("Unsupported resource schema version")
              // v1 had only projectKey. Keep its identity, adding the v2 status mapping.
              return { ...config, mapping: { ...defaults } }
            },
          },
          async pull(binding, options) {
            if (binding.resource.kind !== "plugin") throw new Error("Expected plugin resource")
            const config = configOf(binding.resource.config)
            const connection = await ctx.auth.connections.get({
              service: "auth.example-tracker",
              scopes: ["issues.read"],
            })
            if (!connection) throw new Error("Example Tracker connection unavailable")
            if (binding.connectionRef && connection.ref !== binding.connectionRef)
              throw new Error("Example Tracker connection identity changed")
            const account = (await ctx.integrations.listAccounts("issues")).find(
              (item) => item.connectionId === connection.ref
            )
            if (!account) throw new Error("Connect and grant Example Tracker issue access first")
            const url = new URL(
              `https://api.example-tracker.test/projects/${encodeURIComponent(config.projectKey)}/issues`
            )
            if (!options.full && options.since !== undefined)
              url.searchParams.set("since", String(options.since))
            const response = await ctx.integrations.authenticatedRequest<unknown>(
              account.id,
              url.href,
              { signal: options.signal }
            )
            if (response.status < 200 || response.status >= 300)
              throw response.status === 404 || response.status === 403
                ? new DocsProviderError(response.status === 404 ? "notFound" : "noPermission")
                : new Error(`Issue pull failed (${response.status})`)
            const page = response.data as { items?: unknown; nextCursor?: unknown } | null
            if (!page || !Array.isArray(page.items)) throw new Error("Invalid issue page")
            // This minimal read-only protocol returns one page. Refuse truncation so the Host cannot advance its watermark past missing items.
            if (page.nextCursor) throw new Error("Example Tracker issue page is incomplete")
            return {
              notModified: false,
              items: page.items.map((value: unknown) => {
                const item = value as {
                  id?: unknown
                  title?: unknown
                  description?: unknown
                  state?: unknown
                  updatedAt?: unknown
                } | null
                if (
                  !item ||
                  typeof item.id !== "string" ||
                  !item.id ||
                  typeof item.title !== "string" ||
                  (item.description !== undefined && typeof item.description !== "string") ||
                  (item.state !== "open" && item.state !== "closed") ||
                  typeof item.updatedAt !== "number" ||
                  !Number.isFinite(item.updatedAt)
                )
                  throw new Error("Invalid remote issue")
                return {
                  externalId: `${config.projectKey}:${item.id}`,
                  title: item.title,
                  description: item.description as string | undefined,
                  status: config.mapping[item.state],
                  remoteUpdatedAt: item.updatedAt,
                }
              }),
            }
          },
        })
      )
    }
    await register()
    return {
      onDisable: () => dispose(),
      onUnload: () => dispose(),
      async onCommand(command) {
        if (command !== "example-issues-connect") return false
        const granted = await requestAccess(ctx)
        if (granted) await register()
        return { handled: true, message: ctx.i18n.t(granted ? "access.granted" : "access.denied") }
      },
    }
  },
})
