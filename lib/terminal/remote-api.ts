/**
 * Typed client for the request/response terminal RPCs.
 *
 * The live, interactive PTY stream stays on its own channels
 * (`Channel` over Tauri IPC locally, `/ws/terminal` remotely — see
 * `transport-ws.ts`); everything here is one-shot request/response and rides
 * the process-wide `Transport` (`@/lib/tauri`), so the SAME calls work from
 * the desktop renderer (Tauri `invoke`), the Capacitor mobile shell
 * (companion `/api/_rpc/*`), and the WebRTC RPC tier.
 *
 * Server side: local arms in `src-tauri/src/terminal/`, remote arms in
 * `crates/cognia-companion-rpc/src/rpc.rs` (the `terminal_*` section). Over the
 * companion transport, `exec` / `kill` / `killPort` / `completePaths` require
 * the device's remote-control capability (403 otherwise); the listings are
 * plain paired reads.
 */

import type { Page } from "@/lib/tauri/companion-paging"
import { transport } from "@/lib/tauri"

import {
  callWithTerminalAdminLease,
  openBoundSessionTarget,
  type BoundSessionExecutionTarget,
} from "./host-target"
import type { SessionInfo } from "./types"

/** One-shot command capture — mirrors Rust `terminal::exec::ExecResult`. */
export interface RemoteExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

/** Path-completion candidate — mirrors Rust `terminal::complete::PathCandidate`. */
export interface RemotePathCandidate {
  name: string
  isDir: boolean
}

export interface RemoteExecRequest {
  /**
   * Program to run (PATH-resolvable name or absolute path) — or, with
   * `shell: true`, a complete shell command line.
   */
  command: string
  /** argv after the program. Must be omitted/empty when `shell` is true. */
  args?: string[]
  /** Working directory; defaults to the host process cwd. */
  cwd?: string
  /** Extra environment merged over the host process env. */
  env?: Record<string, string>
  /** Kill-after budget; host default 120 000, max 600 000. */
  timeoutMs?: number
  /**
   * Run `command` as a full shell line via the host's platform shell
   * (`cmd /C` on Windows, `sh -c` elsewhere) so pipes / `&&` / redirects
   * work — what replaying a history command needs.
   */
  shell?: boolean
  /** Short-lived Host approval used by paired clients for interactive execution. */
  adminLease?: string
}

// Listing and killing are deliberately NOT re-exported here.
//
// Every production path already resolves without them: `lib/terminal/rehydrate.ts`
// dispatches on `selectTerminalTransportChain()` to `listAllTerminals()` or
// `RemoteTerminalSession.listLan/listWan()` (which resolve through
// `getActiveRemoteEndpoint()`, so "desktop driving a remote host" is covered
// over the WS frames), and killing goes through `killFromDock` → `session.kill()`.
// The transport-routed twins that used to live here had no callers, no type-level
// dormancy note, and no pinning test — three-of-three missing is dead code, not
// intentional dormancy. The Rust arms in `cognia-companion-rpc/src/rpc.rs` remain, so
// restoring one is a single export away.

/**
 * Run a one-shot command to completion on the host and capture its output.
 * No PTY, no shell — `command` is exec'd directly with `args`.
 */
export async function execTerminalCommand(request: RemoteExecRequest): Promise<RemoteExecResult> {
  return transport.call<RemoteExecResult>("terminal_exec", {
    command: request.command,
    args: request.args,
    cwd: request.cwd,
    env: request.env,
    timeoutMs: request.timeoutMs,
    shell: request.shell,
    adminLease: request.adminLease,
  })
}

/**
 * Host-side path completion for the fragment under the cursor, resolved
 * against `cwd`. Dirs rank before files; `limit` defaults to 50 on the host.
 */
export async function completeTerminalPaths(options: {
  cwd: string
  fragment: string
  showHidden?: boolean
  limit?: number
}): Promise<RemotePathCandidate[]> {
  return transport.call<RemotePathCandidate[]>("terminal_complete_paths", {
    cwd: options.cwd,
    fragment: options.fragment,
    showHidden: options.showHidden,
    limit: options.limit,
  })
}

/**
 * Session-bound twin of {@link completeTerminalPaths}: routes path completion
 * to the exact Host that owns `session` and refuses SSH/serial/extension tabs
 * so local files never leak into remote shell completions (T08).
 */
export async function completeTerminalPathsForSession(
  session: {
    kind?: SessionInfo["kind"]
    origin?: SessionInfo["origin"]
    remoteHost?: SessionInfo["remoteHost"]
  },
  options: {
    cwd: string
    fragment: string
    showHidden?: boolean
    limit?: number
  },
  deps?: {
    openTarget?: (s: typeof session) => Promise<BoundSessionExecutionTarget>
  }
): Promise<RemotePathCandidate[]> {
  const bound = await (deps?.openTarget ?? openBoundSessionTarget)(session)
  try {
    return await bound.transport.call<RemotePathCandidate[]>("terminal_complete_paths", {
      cwd: options.cwd,
      fragment: options.fragment,
      showHidden: options.showHidden,
      limit: options.limit,
    })
  } finally {
    bound.close()
  }
}

/**
 * Host-side `$PATH` executable names matching `prefix`, for head-word
 * completion. The host keeps a 15-second scan cache, so repeated keystrokes
 * cost one directory walk, not one per character.
 *
 * A blank prefix returns nothing by design — completion needs a typed head, and
 * dumping the whole PATH over the companion transport is not a useful answer.
 */
export async function listTerminalPathExecutables(options: {
  prefix: string
  limit?: number
}): Promise<string[]> {
  if (options.prefix.trim().length === 0) return []
  const page = await transport.call<Page<string>>("terminal_list_path_executables", {
    prefix: options.prefix,
    pageSize: options.limit,
  })
  return page.items
}

/**
 * Session-bound twin of {@link listTerminalPathExecutables}: scans executables
 * on the exact Host that owns `session` (supporting mobile, paired web, and
 * cross-host tabs) while refusing SSH/serial/extension tabs (T08).
 */
export async function listTerminalPathExecutablesForSession(
  session: {
    kind?: SessionInfo["kind"]
    origin?: SessionInfo["origin"]
    remoteHost?: SessionInfo["remoteHost"]
  },
  options: {
    prefix: string
    limit?: number
  },
  deps?: {
    openTarget?: (s: typeof session) => Promise<BoundSessionExecutionTarget>
  }
): Promise<string[]> {
  if (options.prefix.trim().length === 0) return []
  const bound = await (deps?.openTarget ?? openBoundSessionTarget)(session)
  try {
    const page = await bound.transport.call<Page<string>>("terminal_list_path_executables", {
      prefix: options.prefix,
      pageSize: options.limit,
    })
    return page.items
  } finally {
    bound.close()
  }
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`)
  }
}

/**
 * Free a TCP port on the host by killing its listener(s). Returns the PIDs
 * that were signalled (possibly empty — nothing was listening).
 */
export async function killTerminalPort(port: number): Promise<number[]> {
  assertValidPort(port)
  return transport.call<number[]>("terminal_kill_port", { port })
}

/**
 * Free a TCP port on the exact Host that owns `session` (never routing an SSH
 * or cross-host tab onto the local desktop), acquiring a device-bound
 * `adminLease` when the target is remote (T03).
 */
export async function killTerminalPortForSession(
  session: {
    kind?: SessionInfo["kind"]
    origin?: SessionInfo["origin"]
    remoteHost?: SessionInfo["remoteHost"]
  },
  port: number,
  deps?: {
    openTarget?: (s: typeof session) => Promise<BoundSessionExecutionTarget>
    callWithLease?: typeof callWithTerminalAdminLease
  }
): Promise<number[]> {
  assertValidPort(port)
  const bound = await (deps?.openTarget ?? openBoundSessionTarget)(session)
  try {
    if (bound.kind === "local") {
      return await bound.transport.call<number[]>("terminal_kill_port", { port })
    }
    return await (deps?.callWithLease ?? callWithTerminalAdminLease)<number[]>(
      "terminal_kill_port",
      { port },
      {
        transport: bound.transport,
        targetKey: bound.key,
      }
    )
  } finally {
    bound.close()
  }
}
