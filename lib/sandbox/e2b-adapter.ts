/** ADR-0233: one Host-bound E2B lifecycle adapter; no local GUI fallback. */
import {
  managedDesktopClient,
  type ManagedDesktopClient,
  type ManagedDesktopCreation,
  type ManagedDesktopResource,
} from "@/lib/automation/managed-desktop-client"
import type { SandboxConnectionRow, SandboxLifecycleState } from "@/types/sandbox"
import {
  SandboxCapabilityError,
  type SandboxAdapterOutcome,
  type SandboxProviderAdapter,
} from "./lifecycle-contract"

import {
  delegatedManagedDesktopWorkspace,
  hasCurrentManagedDesktopQualification,
} from "./connection-capabilities"
import { localTransport } from "@/lib/tauri/transport-instance"
import type { SandboxExecOutcome } from "@/lib/automation/sandbox-client"
import type { LumeAdapterOptions } from "./lume-adapter"
import { MicrovmAdapterError, type MicrovmRequest } from "@cognia/plugin-sdk/api/sandbox"
import { attestManagedPolicy } from "./docker-policy-attestation"

/** All managed shell/file entry points attest before dispatching to the Host. */
export function requireManagedPolicy(
  config: Parameters<typeof attestManagedPolicy>[0],
  policy: Partial<MicrovmRequest>,
  cwd?: string
): void {
  const attestation = attestManagedPolicy(config, policy, cwd)
  if (!attestation.attested)
    throw new MicrovmAdapterError("policy-not-attested", attestation.reason)
}

export interface ManagedDesktopAdapterOptions extends LumeAdapterOptions {
  managedClient?: ManagedDesktopClient
  /** WP8 renderer tags; the Host revalidates the delegation on every call. */
  managedAgent?: { sessionKey: string; characterId?: string }
  /** Single-use authorization issued by the owning Host after human consent. Never persisted in the row. */
  managedCreation?: ManagedDesktopCreation
}

export function managedDesktopLifecycleState(
  state: ManagedDesktopResource["state"]
): SandboxLifecycleState {
  switch (state) {
    case "destroyRetrying":
      return "deleting"
    case "destroyed":
      return "uninitialized"
    default:
      return state
  }
}

export function buildE2bSandboxAdapter(
  row: SandboxConnectionRow,
  outcome: SandboxAdapterOutcome,
  options: ManagedDesktopAdapterOptions = {}
): SandboxProviderAdapter {
  if (row.config.provider !== "e2b") throw new Error("E2B adapter requires its own configuration")
  const config = row.config
  const api = options.managedClient ?? managedDesktopClient
  const reference = () => {
    if (!config.desktopId || !Number.isSafeInteger(config.generation) || config.generation! < 1) {
      throw new SandboxCapabilityError({
        code: "not-connected",
        operation: "connect",
        provider: "e2b",
        driver: row.driver,
      })
    }
    return { desktopId: config.desktopId, generation: config.generation! }
  }
  return {
    provider: "e2b",
    driver: "computer-server",
    workspaceRead: async (ctx, path) => {
      if (!delegatedManagedDesktopWorkspace(row))
        throw new SandboxCapabilityError({
          code: "provider-unqualified",
          operation: "workspaceRead",
          provider: "e2b",
          driver: row.driver,
        })
      if (!options.managedAgent?.sessionKey) throw new Error("managed_desktop_delegation_required")
      requireManagedPolicy(config, { readable: [path] })
      return localTransport.call<string>("cua_sandbox_read_file", {
        connectionId: ctx.connectionId,
        path,
        maxBytes: 8 * 1024 * 1024,
        ...options.managedAgent,
      })
    },
    workspaceExec: async (ctx, request) => {
      if (!delegatedManagedDesktopWorkspace(row))
        throw new SandboxCapabilityError({
          code: "provider-unqualified",
          operation: "workspaceExec",
          provider: "e2b",
          driver: row.driver,
        })
      if (Object.keys(request.env ?? {}).length || request.stdin !== undefined)
        throw new Error("managed_desktop_exec_env_stdin_unsupported")
      requireManagedPolicy(config, request.policy ?? {}, request.cwd)
      if (!options.managedAgent?.sessionKey) throw new Error("managed_desktop_delegation_required")
      return localTransport.call<SandboxExecOutcome>("cua_sandbox_exec", {
        connectionId: ctx.connectionId,
        argv: request.argv,
        cwd: request.cwd,
        env: request.env,
        stdin: request.stdin,
        timeoutMs: request.timeoutMs,
        ...options.managedAgent,
      })
    },
    create: async () => {
      if (!hasCurrentManagedDesktopQualification(config))
        throw new SandboxCapabilityError({
          code: "provider-unqualified",
          operation: "create",
          provider: "e2b",
          driver: row.driver,
        })
      const request = options.managedCreation
      if (
        !request ||
        request.providerConfigId !== config.providerConfigId ||
        !request.authorizationId ||
        !request.quoteId ||
        !request.idempotencyKey
      ) {
        throw new SandboxCapabilityError({
          code: "authorization-required",
          operation: "create",
          provider: "e2b",
          driver: row.driver,
        })
      }
      outcome.managedDesktop = await api.create(config.target, request)
    },
    connect: async () => {
      outcome.managedDesktop = await api.connect(config.target, reference())
    },
    delete: async () => {
      outcome.managedDesktop = await api.delete(config.target, reference())
    },
    health: async () => {
      const report = await api.health(config.target, reference())
      outcome.managedDesktop = report.desktop
      outcome.health = report.reachable
      return {
        reachable: report.reachable,
        state: managedDesktopLifecycleState(report.state),
        ...(report.errorCode ? { error: report.errorCode } : {}),
      }
    },
  }
}
