/**
 * Typed access to `protocol/external-agent-security-policy.json`.
 *
 * The launch-side twin of the capability manifest: that one says what an agent
 * CAN do, this one says what Cognia is willing to LAUNCH. Both are single
 * sources, and for the same reason — the allowlist, the sandbox platform gate
 * and the per-agent writable roots each used to exist twice (a TypeScript copy
 * in the CLI's sandbox launcher and a Rust copy in `cognia-external-agent`),
 * with a comment asking future readers to keep them in union. They had already
 * drifted: Rust rejected the `claude-agent-acp` binary the `claude-code` preset
 * actually spawns, carried a `cline` entry no preset references, and neither
 * side gave OpenCode a state root.
 *
 * TypeScript imports this file and Rust compiles it in with `include_str!`, so
 * the two hosts read one copy; `pnpm audit:agent-capabilities` fails when
 * either carries its own.
 */

import POLICY from "@/protocol/external-agent-security-policy.json"

export type SandboxPlatform = "darwin" | "linux" | "win32" | string

interface RawPolicy {
  version: number
  sandbox: { supportedPlatforms: string[]; reasonKey: string }
  binaryAllowlist: { commands: string[] }
  npxPackageAllowlist: { packages: string[] }
  launchEnvironment: ExternalAgentLaunchEnvironment
}

/** What a launch inherits from the Host's own environment, by mode (ADR-0243 3C). */
export interface ExternalAgentLaunchEnvironment {
  /** Every launch. */
  essentialKeys: readonly string[]
  /** The owner's own run: the person's session layout and toolchain roots. */
  sessionKeys: readonly string[]
  /** The owner's own run only: the person's SSH agent and model-provider credentials. */
  ownerKeys: readonly string[]
  ownerPrefixes: readonly string[]
  /** An isolated launch: session keys that carry no credential, and its fixed values. */
  isolatedKeys: readonly string[]
  isolatedSet: Readonly<Record<string, string>>
  /** Host-owned keys a request may set, which the owner's own run also inherits. */
  configKeys: readonly string[]
  configPrefixes: readonly string[]
}

const policy = POLICY as unknown as RawPolicy

export const EXTERNAL_AGENT_SECURITY_POLICY_VERSION = policy.version

/** Platforms that can run the mandatory sandbox. */
export const SANDBOX_SUPPORTED_PLATFORMS: readonly string[] = policy.sandbox.supportedPlatforms

/** i18n key for "this platform cannot run external agents at all". */
export const SANDBOX_UNSUPPORTED_REASON_KEY = policy.sandbox.reasonKey

/** Bare binary names an external-agent spawn may execute. */
export const EXTERNAL_AGENT_BINARY_ALLOWLIST: readonly string[] = policy.binaryAllowlist.commands

/** Packages `npx` may execute. */
export const EXTERNAL_AGENT_NPX_ALLOWLIST: readonly string[] = policy.npxPackageAllowlist.packages

export const EXTERNAL_AGENT_LAUNCH_ENVIRONMENT: ExternalAgentLaunchEnvironment =
  policy.launchEnvironment

/**
 * The env variable a configuration sets to ask its spawn backend for a private
 * state root. The value is the configuration id; the backend owns the path.
 */
export const AGENT_STATE_KEY_ENV = "COGNIA_AGENT_STATE_KEY"

/** What a state key may look like: a config id, never a path. */
export const AGENT_STATE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Tauri's `@tauri-apps/plugin-os` spells platforms differently from Node.
 * Accepting both means a caller never has to remember which side it is on.
 */
const PLATFORM_ALIASES: Record<string, string> = {
  macos: "darwin",
  windows: "win32",
  win: "win32",
}

/**
 * Can this platform host an external agent?
 *
 * Answered from the policy rather than from `process.platform` directly so the
 * renderer, the CLI and the settings UI all refuse on the same platforms — the
 * Windows case is the one that matters, and it has to be visible in the UI
 * BEFORE a user configures an agent that could never start. Previously the only
 * place that knew was a `throw` deep inside the CLI's launcher, so a Windows
 * user could configure a Codex agent, save it, connect it, and only then learn
 * that Cognia never runs an external agent unsandboxed.
 */
export function externalAgentSandboxSupportsPlatform(platform?: string): boolean {
  const raw =
    platform ??
    (typeof process !== "undefined" && typeof process.platform === "string"
      ? process.platform
      : // A browser renderer has no platform and no spawn path either, so
        // there is nothing to sandbox and nothing to refuse.
        "darwin")
  const normalized = PLATFORM_ALIASES[raw] ?? raw
  return SANDBOX_SUPPORTED_PLATFORMS.includes(normalized)
}

/** Strip a Windows executable suffix and lower-case, as both launchers do. */
export function baseCommandName(command: string): string {
  const base = command
    .trim()
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, "")
  // Goose is system-owned; runtime discovery may return its absolute executable.
  return /(?:^|[\\/])goose$/.test(base) ? "goose" : base
}
