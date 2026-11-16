/**
 * The headless arm of the external-Agent version probe.
 *
 * Same command name and same answer shape as the desktop host
 * (`crates/cognia-external-agent/src/version_probe.rs`), so the renderer runs
 * one certification flow everywhere — the arrangement `check_command_exists`,
 * `resolve_pi_extension` and the four `dsh_runtime_*` commands already use.
 *
 * The caller passes a catalog id and nothing else. The command, its argument
 * vector and its timeout are read here from the shared catalog, so this can
 * never widen into an arbitrary-exec RPC arm reachable from a paired device.
 *
 * Facts only, no verdict: `assessRuntimeVersion()` decides what a version
 * means, and lives in one place so the two hosts cannot drift.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { findRuntimeById } from "@/lib/ai/agent/external/config/install-catalog"

import {
  agentSearchDirs,
  defaultAgentPathRuntime,
  resolveAgentSearchPath,
  type AgentPathRuntime,
} from "./agent-path"
import { hashHex } from "../crypto-hasher"
import { companionFor, type EngineCompanion } from "./launch-descriptor"
import {
  nativeBridgeInterpreterEnvironment,
  resolveNativeBridgeInterpreter,
} from "./native-bridges"

/** Commands that run *another* package rather than being the runtime itself. */
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx"])

/** Matches the desktop cap; a failing probe can print a whole install log. */
const MAX_OUTPUT_BYTES = 8 * 1024

/** Mirrors `RuntimeVersionProbe` in Rust, field for field. */
export interface RuntimeVersionProbe {
  output: string | null
  executablePath: string | null
  executableDigest: string | null
  exitCode: number | null
  detail: string | null
}

const ABSENT: RuntimeVersionProbe = {
  output: null,
  executablePath: null,
  executableDigest: null,
  exitCode: null,
  detail: null,
}

export interface ProbeRuntimeVersionDeps {
  runtime?: AgentPathRuntime
  spawnFn?: typeof spawn
  resolveBridgeInterpreter?: () => string
}

/** Keep partial test/runtime env bags inside this repo's strict Node env contract. */
export function normalizeProbeNodeEnv(value: string | undefined): NodeJS.ProcessEnv["NODE_ENV"] {
  return value === "development" || value === "test" || value === "production"
    ? value
    : "production"
}

/** Resolve a bare command against the enriched search path, as the spawn does. */
export function resolveProbeExecutable(
  command: string,
  runtime: AgentPathRuntime = defaultAgentPathRuntime()
): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return fs.existsSync(trimmed) ? trimmed : null
  }

  // As the desktop resolves (`command_resolver.rs`): the name itself, then on
  // Windows the name with each PATHEXT extension in place of its own.
  const names =
    runtime.platform === "win32"
      ? [
          trimmed,
          ...(runtime.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .map((extension) => extension.trim().replace(/^\./, "").toLowerCase())
            .filter(Boolean)
            .map((extension) => `${path.parse(trimmed).name}.${extension}`),
        ]
      : [trimmed]
  for (const dir of agentSearchDirs(runtime)) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // Next candidate.
      }
    }
  }
  return null
}

/** Is this the runtime's own executable, or a runner that fetches one? */
export function isPackageRunner(command: string): boolean {
  const base = command.split(/[/\\]/).pop()?.toLowerCase() ?? ""
  return PACKAGE_RUNNERS.has(base.replace(/\.(?:exe|cmd|bat)$/, ""))
}

function truncate(text: string): string {
  return Buffer.byteLength(text) <= MAX_OUTPUT_BYTES
    ? text
    : Buffer.from(text).subarray(0, MAX_OUTPUT_BYTES).toString("utf8")
}

function digestOf(file: string): string | null {
  try {
    return hashHex("sha256", fs.readFileSync(file))
  } catch {
    return null
  }
}

/** An engine that loads a companion binds both byte sequences into its consent identity. */
export async function companionBundleDigest(companion: EngineCompanion): Promise<string> {
  const hashFile = async (file: string): Promise<string> => {
    const hash = createHash("sha256")
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    return hash.digest("hex")
  }
  const serverDigest = await hashFile(companion.executablePath)
  const helperDigest = await hashFile(companion.helperPath)
  return hashHex("sha256", `${companion.engine}-v1\n${serverDigest}\n${helperDigest}\n`)
}

/**
 * Run one runtime's catalogued version probe.
 *
 * A timeout or a non-zero exit still returns `output`, because "the version is
 * unreadable" and "the runtime is not installed" are different facts and the
 * certification policy treats them differently. Only a command that cannot be
 * found at all reports `output: null`.
 */
export async function probeRuntimeVersion(
  runtimeId: string,
  deps: ProbeRuntimeVersionDeps = {}
): Promise<RuntimeVersionProbe> {
  const entry = findRuntimeById(runtimeId)
  if (!entry) throw new Error(`unknown runtime: ${runtimeId}`)

  if (!entry.versionProbe) {
    return { ...ABSENT, detail: `${runtimeId} declares no version probe` }
  }
  if (!entry.systemCommand) {
    return { ...ABSENT, detail: `${runtimeId} has no system command to probe` }
  }

  const runtime = deps.runtime ?? defaultAgentPathRuntime()
  // Codebuff runs on a verified plain Node, which need not be the host executable.
  // Its only interpreter probe is fixed here, independently of caller input.
  if (
    runtimeId === "codebuff" &&
    (entry.systemCommand !== "node" ||
      entry.versionProbe.args.length !== 1 ||
      entry.versionProbe.args[0] !== "--version")
  )
    throw new Error("Codebuff host Node probe must be exactly node --version")
  let executablePath: string | null
  try {
    executablePath =
      runtimeId === "codebuff"
        ? (
            deps.resolveBridgeInterpreter ??
            (() =>
              deps.runtime
                ? resolveNativeBridgeInterpreter({ runtime })
                : resolveNativeBridgeInterpreter())
          )()
        : resolveProbeExecutable(entry.systemCommand, runtime)
  } catch (error) {
    return { ...ABSENT, detail: error instanceof Error ? error.message : String(error) }
  }
  if (!executablePath) {
    return {
      ...ABSENT,
      detail: `${entry.systemCommand} is not on PATH or any known install root`,
    }
  }

  // The resolved file for a package runner is `npx`, not the runtime. Recording
  // its digest as the runtime's identity would make an unpinned runtime look
  // stable while the package under it changed on every launch.
  let executableDigest: string | null
  let companion: EngineCompanion | undefined
  try {
    companion = companionFor(entry.systemCommand, (command) =>
      resolveProbeExecutable(command, runtime)
    )
    if (companion) executablePath = companion.executablePath
    executableDigest = companion
      ? await companionBundleDigest(companion)
      : isPackageRunner(entry.systemCommand)
        ? null
        : digestOf(executablePath)
  } catch (error) {
    return {
      output: "",
      executablePath,
      executableDigest: null,
      exitCode: null,
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const spawnFn = deps.spawnFn ?? spawn
  const { timeoutMs } = entry.versionProbe

  return new Promise<RuntimeVersionProbe>((resolve) => {
    let settled = false
    let collected = ""

    const child = spawnFn(executablePath, [...entry.versionProbe!.args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...(runtimeId === "codebuff"
          ? nativeBridgeInterpreterEnvironment(runtime.env)
          : runtime.env),
        NODE_ENV: normalizeProbeNodeEnv(runtime.env.NODE_ENV ?? process.env.NODE_ENV),
        PATH: resolveAgentSearchPath(runtime),
        ...(companion ? { [companion.env]: companion.helperPath } : {}),
      },
      // Own group, so the timeout kill takes the whole tree: `npx` forks
      // `node`, and killing only the parent leaves it running.
      detached: process.platform !== "win32",
    })

    const settle = (result: RuntimeVersionProbe) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      killTree(child.pid)
      settle({
        output: "",
        executablePath,
        executableDigest,
        exitCode: null,
        detail: `probe timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    // Several of these CLIs print their version on stderr.
    child.stdout?.on("data", (chunk: Buffer) => {
      collected += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      collected += chunk.toString()
    })

    child.on("error", (error: Error) => {
      settle({
        // It started resolving, so it is not "missing"; it just told us nothing.
        output: "",
        executablePath,
        executableDigest,
        exitCode: null,
        detail: `probe failed: ${error.message}`,
      })
    })

    child.on("close", (code: number | null) => {
      settle({
        output: truncate(collected),
        executablePath,
        executableDigest,
        exitCode: code,
        detail: null,
      })
    })
  })
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    // Negative pid = the whole group created by `detached`.
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL")
  } catch {
    // Already gone.
  }
}
