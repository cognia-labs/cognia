/**
 * Shared harness for the external-agent smokes under scripts/smoke/agents/.
 *
 * Every smoke drives a real vendor CLI through Cognia's own CLI host: the
 * installed external-agent host, the strict sandbox launcher and the real
 * adapter. Before this kit each smoke rebuilt that setup by hand, and most of
 * them silently stopped working when the host became an explicit install
 * (ADR-0217): they selected a workspace but never installed the host, so every
 * connect failed with "stdio needs a runtime that can start a process".
 * `withSmokeContext` is the one place that setup now lives.
 */
import "./cli-host"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  installCliExternalAgentHost,
  selectCliAgentWorkspace,
} from "@/cli/src/runtime/external/host-branch"
import { findSandboxLauncher } from "@/cli/src/runtime/external/sandbox-launcher"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"
import type { createAcpClientAdapter } from "@/lib/ai/agent/external/integrations/acp"
import type {
  AcpElicitationRequest,
  AcpElicitationValue,
  ExternalAgentConfig,
  ExternalAgentContent,
} from "@/types/agent/external-agent"

export type AcpAdapter = ReturnType<typeof createAcpClientAdapter>
export type PresetId = Parameters<typeof createAgentFromPreset>[0]

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export interface SmokeOptions {
  /** Use the real local login or provider credentials; spends model calls. */
  live: boolean
  /** Keep the scratch directory for inspection instead of removing it. */
  keep: boolean
}

export interface SmokeContext extends SmokeOptions {
  /** Realpath of a fresh directory that is also the selected agent workspace. */
  scratch: string
  /** Register cleanup; runs in reverse order even when the smoke fails. */
  defer(cleanup: () => unknown): void
  /** A unique marker the model must echo back, so a reply cannot be a coincidence. */
  marker(prefix: string): string
}

const LAUNCHER_REMEDY =
  "The external-agent sandbox launcher is missing. Build it with `pnpm cli:external-host:build`, " +
  "or point COGNIA_EXTERNAL_AGENT_LAUNCHER at a built cognia-external-agent-launcher."

/** Fail before any agent starts when the sandbox launcher cannot be found. */
export function requireSandboxLauncher(
  find: () => string | undefined = findSandboxLauncher
): string {
  const launcher = find()
  if (!launcher) throw new Error(LAUNCHER_REMEDY)
  return launcher
}

/**
 * Run `body` with Cognia's CLI host installed and a fresh scratch workspace
 * selected, then undo everything it registered, in reverse order.
 */
export async function withSmokeContext<T>(
  name: string,
  options: SmokeOptions,
  body: (context: SmokeContext) => Promise<T>
): Promise<T> {
  requireSandboxLauncher()
  const uninstallHost = installCliExternalAgentHost()
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cognia-smoke-${name}-`)))
  const cleanups: Array<() => unknown> = []
  const context: SmokeContext = {
    ...options,
    scratch,
    defer: (cleanup) => cleanups.push(cleanup),
    marker: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`,
  }
  selectCliAgentWorkspace(scratch)
  try {
    return await body(context)
  } finally {
    const failures: string[] = []
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    selectCliAgentWorkspace(process.cwd())
    uninstallHost()
    if (options.keep) console.error(`[smoke] kept ${scratch}`)
    else fs.rmSync(scratch, { recursive: true, force: true })
    if (failures.length) console.error(`[smoke] cleanup failed: ${failures.join("; ")}`)
  }
}

/** Set environment variables for the rest of the smoke; the context restores them. */
export function overrideEnv(context: SmokeContext, values: Record<string, string>): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  context.defer(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

export interface AgentConfigOverrides {
  command?: string
  args?: string[]
  env?: Record<string, string>
  timeout?: number
  requireApprovalFor?: string[]
}

/** A preset's config pointed at the scratch workspace, with retries off so failures surface. */
export function presetConfig(
  presetId: PresetId,
  context: SmokeContext,
  overrides: AgentConfigOverrides = {}
): ExternalAgentConfig {
  const config = createAgentFromPreset(presetId, {
    id: `${presetId}-smoke-${randomUUID()}`,
    process: {
      // An empty command or absent args fall back to the preset's own launch.
      command: overrides.command ?? "",
      ...(overrides.args ? { args: overrides.args } : {}),
      cwd: context.scratch,
      env: overrides.env ?? {},
    },
    ...(overrides.requireApprovalFor ? { requireApprovalFor: overrides.requireApprovalFor } : {}),
    timeout: overrides.timeout ?? 30_000,
    retryConfig: { maxRetries: 0, retryDelay: 0, exponentialBackoff: false },
  })
  check(config, `Missing external-agent preset ${presetId}`)
  return config
}

/** Connect and disconnect with the context; sessions created later are deleted first. */
export async function connect(
  context: SmokeContext,
  adapter: AcpAdapter,
  config: ExternalAgentConfig
): Promise<void> {
  context.defer(() => adapter.disconnect())
  await adapter.connect(config)
}

/** Delete `sessionId` at cleanup unless the smoke deleted it itself. */
export function ownSession(context: SmokeContext, adapter: AcpAdapter, sessionId: string): void {
  context.defer(() => adapter.deleteSession(sessionId).catch(() => undefined))
}

/** Is this the error an agent raises for a session it cannot authenticate? */
export function isAuthenticationRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /auth|login|credential|api[ _-]?key|unauthori[sz]ed|sign[ -]?in/i.test(message)
}

/** Answer a form elicitation with the first choice of every field. */
export function firstChoices(request: AcpElicitationRequest): Record<string, AcpElicitationValue> {
  check(request.mode === "form", "Unexpected URL elicitation in a local smoke")
  const content: Record<string, AcpElicitationValue> = {}
  for (const [name, property] of Object.entries(request.requestedSchema?.properties ?? {})) {
    const choices = property.type === "array" ? property.items : property
    const first = choices?.oneOf?.[0]?.const ?? choices?.enum?.[0]
    check(first, `Question field ${name} offers no explicit choice`)
    content[name] = property.type === "array" ? [first] : first
  }
  return content
}

export interface TurnOptions {
  /** Extra prompt content after the text (resources, images). */
  content?: ExternalAgentContent[]
  /** Grant (true) or deny (false) every permission request. */
  allowPermissions?: boolean
  timeout?: number
}

export interface TurnResult {
  reply: string
  stopReason: string | undefined
  /** Count of each event type the turn produced. */
  events: Record<string, number>
}

/** Run one prompt to completion, answering permissions and questions as configured. */
export async function runTurn(
  adapter: AcpAdapter,
  sessionId: string,
  text: string,
  options: TurnOptions = {}
): Promise<TurnResult> {
  let reply = ""
  let stopReason: string | undefined
  const events: Record<string, number> = {}
  for await (const event of adapter.prompt(
    sessionId,
    {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }, ...(options.content ?? [])],
      timestamp: new Date(),
    },
    { timeout: options.timeout ?? 150_000 }
  )) {
    events[event.type] = (events[event.type] ?? 0) + 1
    if (event.type === "message_delta" && event.delta.type === "text") reply += event.delta.text
    if (event.type === "done") stopReason = event.stopReason
    if (event.type === "permission_request")
      await adapter.respondToPermission(sessionId, {
        requestId: event.request.requestId ?? event.request.id,
        granted: options.allowPermissions ?? false,
        scope: "once",
      })
    if (event.type === "elicitation_request")
      await adapter.respondToElicitation({
        requestId: event.request.id,
        action: "accept",
        content: firstChoices(event.request),
      })
    if (event.type === "error") throw new Error(`Agent turn error: ${JSON.stringify(event)}`)
  }
  return { reply, stopReason, events }
}

/** Print a smoke report the way every smoke does: one pretty JSON object on stdout. */
export function printReport(report: Record<string, unknown>): void {
  console.log(JSON.stringify(report, null, 2))
}
