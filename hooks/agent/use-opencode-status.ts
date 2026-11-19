"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { OpenCodeV2Catalog } from "@cognia/agent-opencode/v2-catalog"

/** Normalized snapshot of a connected OpenCode server's status surfaces. */
export interface OpencodeStatus {
  /** Providers known to the server; `connected` marks authenticated ones. */
  providers: Array<{ id: string; name?: string; connected?: boolean }>
  /** Agents (modes) the server exposes. */
  agents: Array<{ id: string; name?: string; description?: string }>
  /** Slash commands the server exposes. */
  commands: Array<{ name: string; description?: string }>
  /** MCP servers by name with their connection state. */
  mcpServers: Array<{ name: string; status?: string }>
  /** LSP servers by id with their state. */
  lspServers: Array<{ id: string; status?: string }>
  /** Unknown and failed reads must never be presented as empty results. */
  surfaces?: Partial<
    Record<
      "providers" | "providerAuth" | "agents" | "commands" | "mcp" | "lsp" | "project",
      "loading" | "partial" | "ready" | "error" | "unsupported"
    >
  >
  /** Current project info (worktree path, VCS kind) when available. */
  project?: { worktree?: string; vcs?: string }
}

const EMPTY_STATUS: OpencodeStatus = {
  providers: [],
  agents: [],
  commands: [],
  mcpServers: [],
  lspServers: [],
  surfaces: {
    providers: "loading",
    agents: "loading",
    commands: "loading",
    mcp: "loading",
    lsp: "loading",
    project: "loading",
  },
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Map `{ name: state }` status payloads (MCP / LSP) into badge rows. */
function statusEntries(value: unknown): Array<{ name: string; status?: string }> {
  const record = asRecord(value)
  if (!record) return []
  return Object.entries(record).map(([name, state]) => {
    const stateRecord = asRecord(state)
    const status =
      typeof stateRecord?.status === "string"
        ? stateRecord.status
        : typeof stateRecord?.state === "string"
          ? stateRecord.state
          : undefined
    return { name, status }
  })
}

/** Read status from either OpenCode API without treating failed reads as empty. */
export function useOpencodeStatus(
  agentId: string,
  connected: boolean
): {
  status: OpencodeStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
} {
  const request = useMemo(() => ({ agentId, connected }), [agentId, connected])
  const [snapshot, setSnapshot] = useState<{
    request: typeof request | null
    status: OpencodeStatus
    loading: boolean
    available: boolean
  }>({ request: null, status: EMPTY_STATUS, loading: false, available: false })
  const issued = useRef(0)
  const catalogBinding = useRef<
    | {
        request: typeof request
        catalog: OpenCodeV2Catalog
        client: object
        directory?: string
        unsubscribe?: () => void
      }
    | undefined
  >(undefined)

  const refresh = useCallback(async () => {
    if (!connected) return
    const ticket = ++issued.current
    const publish = (
      update: Partial<Pick<typeof snapshot, "status" | "loading" | "available">>
    ) => {
      if (issued.current !== ticket) return
      setSnapshot((previous) => ({
        ...(previous.request === request
          ? previous
          : { request, status: EMPTY_STATUS, loading: false, available: false }),
        ...update,
      }))
    }
    publish({ loading: true })
    try {
      const [{ getExternalAgentManager }, { openCodeServerExtension }, { openCodeV2Extension }] =
        await Promise.all([
          import("@/lib/ai/agent/external/manager"),
          import("@cognia/agent-opencode/client"),
          import("@cognia/agent-opencode/v2-client"),
        ])
      if (issued.current !== ticket) return
      const manager = getExternalAgentManager()
      const adapter = manager.getAdapterExtension(agentId, openCodeServerExtension)
      const v2 = adapter ? undefined : manager.getAdapterExtension(agentId, openCodeV2Extension)
      publish({ available: !!(adapter || v2) })
      if (v2) {
        const client = v2.getSdkClient()
        const directory = manager.getAgent(agentId)?.config.process?.cwd
        const input = directory ? { location: { directory } } : undefined
        if (
          catalogBinding.current?.request !== request ||
          catalogBinding.current.client !== client ||
          catalogBinding.current.directory !== directory
        ) {
          catalogBinding.current?.unsubscribe?.()
          catalogBinding.current?.catalog.dispose()
          catalogBinding.current = {
            request,
            client,
            directory,
            catalog: new OpenCodeV2Catalog(client, directory),
          }
        }
        const binding = catalogBinding.current
        binding.unsubscribe?.()
        let reads: Awaited<ReturnType<typeof readStatus>> | undefined
        const readStatus = () =>
          Promise.allSettled([client.mcp.list(input), client.location.get(input)] as const)
        const publishV2 = () => {
          const catalog = binding.catalog.getSnapshot()
          const [mcp, project] = reads ?? []
          publish({
            status: {
              providers: catalog.providers.map(({ id, name, integrationID }) => {
                const integration = catalog.integrations.find((item) => item.id === integrationID)
                return {
                  id,
                  name,
                  connected:
                    catalog.states.integrations === "error"
                      ? undefined
                      : integration
                        ? integration.connections.some((connection) => !connection.status)
                        : undefined,
                }
              }),
              agents: catalog.agents,
              commands: catalog.commands,
              mcpServers:
                mcp?.status === "fulfilled"
                  ? mcp.value.data.map(({ name, status }) => ({ name, status: status.status }))
                  : [],
              lspServers: [],
              project:
                project?.status === "fulfilled" ? { worktree: project.value.directory } : undefined,
              surfaces: {
                providers: catalog.states.providers,
                providerAuth: catalog.states.integrations,
                agents: catalog.states.agents,
                commands: catalog.states.commands,
                mcp: !mcp ? "loading" : mcp.status === "fulfilled" ? "ready" : "error",
                project: !project ? "loading" : project.status === "fulfilled" ? "ready" : "error",
                lsp: "unsupported",
              },
            },
          })
        }
        binding.unsubscribe = binding.catalog.subscribe(publishV2)
        publishV2()
        await Promise.all([
          binding.catalog.refresh(),
          readStatus().then((result) => {
            reads = result
            publishV2()
          }),
        ])
      } else if (adapter) {
        const [mcp, lsp, project] = await Promise.allSettled([
          adapter.getMcpStatus(),
          adapter.getLspStatus(),
          adapter.getProject(),
        ])
        if (issued.current !== ticket) return
        const providerInfo = adapter.getProviders()
        const connectedIds = new Set(providerInfo?.connected ?? [])
        const projectRecord = project.status === "fulfilled" ? asRecord(project.value) : undefined
        publish({
          status: {
            providers: (providerInfo?.all ?? []).map((p) => ({
              id: p.id,
              name: p.name,
              connected: connectedIds.has(p.id),
            })),
            agents: adapter.getAvailableAgents(),
            commands: adapter.getAvailableCommands().map((c) => ({
              name: c.name,
              description: c.description || undefined,
            })),
            mcpServers: mcp.status === "fulfilled" ? statusEntries(mcp.value) : [],
            lspServers:
              lsp.status === "fulfilled"
                ? Array.isArray(lsp.value)
                  ? lsp.value.map((server) => ({ id: server.id, status: server.status }))
                  : statusEntries(lsp.value).map(({ name, status }) => ({ id: name, status }))
                : [],
            project: projectRecord
              ? {
                  worktree:
                    typeof projectRecord.worktree === "string" ? projectRecord.worktree : undefined,
                  vcs: typeof projectRecord.vcs === "string" ? projectRecord.vcs : undefined,
                }
              : undefined,
            surfaces: {
              providers: "ready",
              agents: "ready",
              commands: "ready",
              mcp: mcp.status === "fulfilled" ? "ready" : "error",
              lsp: lsp.status === "fulfilled" ? "ready" : "error",
              project: project.status === "fulfilled" ? "ready" : "error",
            },
          },
        })
      }
    } catch {
      if (issued.current === ticket) {
        publish({
          status: {
            ...EMPTY_STATUS,
            surfaces: {
              providers: "error",
              agents: "error",
              commands: "error",
              mcp: "error",
              lsp: "error",
              project: "error",
            },
          },
        })
      }
    } finally {
      publish({ loading: false })
    }
  }, [agentId, connected, request])

  useEffect(() => {
    let alive = true
    let unsubscribe: (() => void) | undefined
    void refresh()
    if (connected)
      void import("@/lib/ai/agent/external/manager")
        .then(({ getExternalAgentManager }) => {
          if (alive)
            unsubscribe = getExternalAgentManager().addLifecycleListener((event) => {
              if (event.agentId === agentId) void refresh()
            })
        })
        .catch(() => undefined)
    return () => {
      alive = false
      unsubscribe?.()
      issued.current += 1
      catalogBinding.current?.unsubscribe?.()
      catalogBinding.current?.catalog.dispose()
      catalogBinding.current = undefined
    }
  }, [refresh, agentId, connected])

  const current = connected && snapshot.request === request
  return {
    status: current ? snapshot.status : EMPTY_STATUS,
    loading: connected && (!current || snapshot.loading),
    available: current && snapshot.available,
    refresh,
  }
}
