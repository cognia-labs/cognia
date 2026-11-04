/**
 * The checks every ACP runtime in protocol/external-agent-runtimes.json gets,
 * with no per-agent code: the catalog's version probe, a connect through
 * Cognia's host and sandbox, the ACP v1 handshake, a session (or the agent's
 * refusal to open one without credentials), and a reconnect. `--live` adds a
 * real model turn that must echo a fresh marker, then list, load and delete.
 *
 * A vendor module (./vendors/) adds what only that agent can show: its own
 * state root, login methods, modes, MCP transports, fork semantics.
 */
import path from "node:path"
import { probeRuntimeVersion } from "@/cli/src/runtime/external/version-probe"
import { findRuntimeById } from "@/lib/ai/agent/external/config/install-catalog"
import { createAcpClientAdapter } from "@/lib/ai/agent/external/integrations/acp"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import {
  check,
  connect,
  isAuthenticationRefusal,
  ownSession,
  presetConfig,
  runTurn,
  withSmokeContext,
  type AcpAdapter,
  type PresetId,
  type SmokeContext,
  type SmokeOptions,
} from "./kit"

/** What the generic lane observed, handed to the vendor module. */
export interface GenericLane {
  adapter: AcpAdapter
  config: ExternalAgentConfig
  init: ReturnType<AcpAdapter["getAcpInitializationMetadata"]>
  /** The session the lane opened, or undefined when the agent refused one. */
  sessionId: string | undefined
}

export interface VendorSmoke {
  runtimeId: string
  /** Defaults to the runtime's first catalog preset. */
  presetId?: PresetId
  /** Environment that keeps the CLI's state inside scratch and off shell credentials. */
  isolatedEnv?: (context: SmokeContext) => Record<string, string>
  /** Environment for `--live`, pointing at the real local login. */
  liveEnv?: (context: SmokeContext) => Record<string, string>
  /** Point HOME and XDG roots into scratch in the default lane. Defaults to true. */
  isolateHome?: boolean
  /** The ACP `agentInfo.name` the agent must report. */
  agentName?: string
  /** Prepare a fresh session before the live marker turn (e.g. pick a mode). */
  prepareSession?: (adapter: AcpAdapter, sessionId: string) => Promise<void>
  /** Vendor checks after the generic lane; the result is merged into the report. */
  run?: (context: SmokeContext, lane: GenericLane) => Promise<Record<string, unknown>>
}

export class RuntimeNotInstalled extends Error {}

/** HOME and XDG roots inside scratch, so a default run reads no user state. */
export function isolatedHomeEnv(scratch: string): Record<string, string> {
  const home = path.join(scratch, "home")
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  }
}

/** Poll until `listed()` turns false; some agents index deletions asynchronously. */
export async function waitUntilUnlisted(
  listed: () => Promise<boolean>,
  timeoutMs = 75_000,
  intervalMs = 1_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!(await listed())) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export async function runAgentSmoke(
  runtimeId: string,
  options: SmokeOptions,
  vendor: VendorSmoke | undefined
): Promise<Record<string, unknown>> {
  const runtime = findRuntimeById(runtimeId)
  if (!runtime) throw new Error(`Unknown runtime ${runtimeId}; see pnpm smoke:agent --list`)
  if (runtime.protocol !== "acp")
    throw new Error(
      `${runtimeId} speaks ${runtime.protocol}; the generic lane covers ACP runtimes only`
    )
  const probe = await probeRuntimeVersion(runtimeId)
  if (!probe.output)
    throw new RuntimeNotInstalled(
      `${runtimeId} is not installed (${probe.detail ?? `${runtime.systemCommand} not found`})`
    )
  const version = probe.output.trim()
  const presetId = vendor?.presetId ?? (runtime.presetIds[0] as PresetId)
  return withSmokeContext(runtimeId, options, async (context) => {
    const env = context.live
      ? (vendor?.liveEnv?.(context) ?? {})
      : {
          ...(vendor?.isolateHome === false ? {} : isolatedHomeEnv(context.scratch)),
          ...(vendor?.isolatedEnv?.(context) ?? {}),
        }
    const config = presetConfig(presetId, context, { env })
    const adapter = createAcpClientAdapter()
    await connect(context, adapter, config)
    const init = adapter.getAcpInitializationMetadata()
    check(init.protocolVersion === 1, `${runtimeId} did not negotiate ACP v1`)
    if (vendor?.agentName)
      check(
        init.agentInfo?.name === vendor.agentName,
        `Unexpected ACP implementation: ${init.agentInfo?.name}`
      )
    const report: Record<string, unknown> = {
      ok: true,
      runtimeId,
      presetId,
      version,
      agent: init.agentInfo,
      protocolVersion: init.protocolVersion,
      sandboxedConnection: true,
      live: context.live,
      advertisedCapabilities: init.agentCapabilities,
      authMethods: adapter.getAuthMethods().map((method) => method.id),
    }

    let sessionId: string | undefined
    try {
      sessionId = (await adapter.createSession({ cwd: context.scratch, mcpServers: [] })).id
      ownSession(context, adapter, sessionId)
      report.session = "created"
    } catch (error) {
      if (context.live || !isAuthenticationRefusal(error)) throw error
      report.session = "authentication-required"
    }

    if (context.live && sessionId) {
      await vendor?.prepareSession?.(adapter, sessionId)
      const marker = context.marker(`${runtimeId.toUpperCase().replaceAll("-", "_")}_OK`)
      const turn = await runTurn(
        adapter,
        sessionId,
        `Do not use any tools. Reply with exactly: ${marker}`,
        { timeout: 120_000 }
      )
      check(turn.reply.trim() === marker, `Unexpected model reply: ${turn.reply}`)
      check(turn.stopReason === "end_turn", `Unexpected stop reason: ${turn.stopReason}`)
      report.markerTurn = turn
    }

    const sessionCapabilities = init.agentCapabilities?.sessionCapabilities
    const listed = async (id: string) =>
      (await adapter.listSessions({ cwd: context.scratch })).some((entry) => entry.sessionId === id)
    // Some agents (Claude Code) persist a session only after its first turn, so
    // an untouched session may be absent from the list; after a live turn it
    // must be there, and only a persisted session is loaded and deleted.
    let persisted = context.live
    if (sessionId && sessionCapabilities?.list) {
      const present = await listed(sessionId)
      if (context.live) check(present, "The session is missing from session/list after a turn")
      persisted = present
      report.list = present ? true : "not listed before its first turn"
    }

    await adapter.disconnect()
    await adapter.connect(config)
    check(adapter.getAcpInitializationMetadata().protocolVersion === 1, "Reconnect failed")
    report.reconnect = true

    if (sessionId && persisted && init.agentCapabilities?.loadSession) {
      await adapter.loadSession(sessionId, { cwd: context.scratch })
      report.reconnectLoad = true
    }
    if (sessionId && persisted && sessionCapabilities?.delete) {
      await adapter.deleteSession(sessionId)
      if (sessionCapabilities.list)
        check(
          await waitUntilUnlisted(() => listed(sessionId!)),
          "The deleted session is still listed"
        )
      report.delete = true
    }

    if (vendor?.run)
      Object.assign(report, await vendor.run(context, { adapter, config, init, sessionId }))
    if (!context.live) report.modelTurn = "not run (pass --live to use the local login)"
    return report
  })
}
