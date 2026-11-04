import type { ProtocolAdapter, SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import type { AgentLogger } from "@cognia/agent-contracts/host"
import { AcpClientAdapter, acpClientExtension } from "./client"
import { DevinAcpAdapter } from "./devin-adapter"
import { MiniMaxAcpAdapter } from "./minimax-adapter"
import { IsolatedAcpAdapter } from "./isolated-adapter"
import { resolveAcpVendorProfile } from "./vendor-profile"
import { ACP_VENDOR_PROFILES } from "./vendor-profiles"

export interface AcpIsolationHost {
  createClient(): AcpClientAdapter
  logger: AgentLogger
  isWithinRoot(path: string, root: string): boolean
  stateKey(key: string): string
  stateKeyEnv: string
}
function matchesNative(config: ExternalAgentConfig, preset: string, commands: readonly string[]) {
  const basename = config.process?.command.split(/[\\/]/).at(-1)
  const command = preset === "minimax-code" ? basename?.toLowerCase() : basename
  return (
    config.metadata?.preset === preset ||
    commands.some((name) => command === name || command === name + ".exe")
  )
}

/**
 * Devin over stdio: `discovery` serves the configuration, and each
 * conversation gets its own ACP client over the same ports.
 */
export function createDevinAcpAdapter(
  discovery: AcpClientAdapter,
  host: AcpIsolationHost
): DevinAcpAdapter {
  return new DevinAcpAdapter(discovery, host.createClient, host.logger)
}

/**
 * Give native Devin one ACP process per conversation. Applies only when the
 * factory registered for `acp` still produced the built-in client: a custom
 * factory a host or plugin registered stays authoritative.
 */
export function isolateNativeDevin(
  config: ExternalAgentConfig,
  adapter: ProtocolAdapter | undefined,
  host: AcpIsolationHost
): ProtocolAdapter | undefined {
  const acp = adapter ? acpClientExtension.resolve(adapter) : undefined
  return config.transport === "stdio" &&
    matchesNative(config, "devin", ["devin"]) &&
    acp?.constructor === AcpClientAdapter
    ? createDevinAcpAdapter(acp, host)
    : adapter
}

/**
 * These protocols bind a viewer to a project. Hermes' viewers deliberately
 * retain one stable host-managed gateway key: native session durability must
 * not depend on the order in which child viewer processes were constructed.
 */
class WorkspaceScopedAcpAdapter extends IsolatedAcpAdapter {
  protected override readonly isolationId: string
  protected override readonly label: string
  constructor(
    id: string,
    label: string,
    discovery: AcpClientAdapter,
    private readonly host: AcpIsolationHost
  ) {
    super(discovery, host.createClient, host.logger)
    this.isolationId = id
    this.label = label
  }
  protected override processConfig(
    suffix: string,
    options?: SessionCreateOptions
  ): ExternalAgentConfig {
    const workspace = this._config?.process?.cwd
    if (!workspace || !(workspace.startsWith("/") || /^[a-z]:[\\/]/i.test(workspace)))
      throw new Error(`${this.label} requires an absolute configured workspace before discovery`)
    const requested = options?.cwd ?? workspace
    if (!this.host.isWithinRoot(requested, workspace))
      throw new Error(`${this.label} session workspace must remain inside the configured workspace`)
    const config = super.processConfig(suffix, options)
    if (this.isolationId !== "hermes-agent") return config
    return {
      ...config,
      process: {
        ...config.process!,
        args: ["--profile", "default", "acp"],
        env: {
          ...config.process!.env,
          [this.host.stateKeyEnv]: this.host.stateKey(this._config!.id),
        },
      },
    }
  }
}

/** Isolate process-wide ACP authority without replacing plugin-owned factories. */
export function isolateNativeAcp(
  config: ExternalAgentConfig,
  adapter: ProtocolAdapter | undefined,
  host: AcpIsolationHost
): ProtocolAdapter | undefined {
  const acp = adapter ? acpClientExtension.resolve(adapter) : undefined
  if (
    config.transport === "stdio" &&
    matchesNative(config, "minimax-code", ["mcode"]) &&
    acp?.constructor === AcpClientAdapter
  )
    return new MiniMaxAcpAdapter(acp, host.createClient, host.logger)
  const profile = resolveAcpVendorProfile(config, ACP_VENDOR_PROFILES)
  if (
    config.transport === "stdio" &&
    acp?.constructor === AcpClientAdapter &&
    profile &&
    ["command-code", "zcode", "hermes-agent"].includes(profile.id)
  )
    return new WorkspaceScopedAcpAdapter(profile.id, profile.label, acp, host)
  return isolateNativeDevin(config, adapter, host)
}
