import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { NodeExternalAgentSpawnConfig } from "./node-backend"

import {
  DEVIN_MCP_SERVERS_ENV,
  DEVIN_MAX_JSON_BYTES,
  DEVIN_MCP_CONFIG_FILES,
  parseDevinJsonc,
  devinServerMap,
  devinInjectedServers,
  assertDevinMcpTarget,
  devinIsolatedPrimaryConfig,
  projectDevinMcpConfig,
} from "@cognia/agent-acp/devin-mcp-config"
export { DEVIN_MCP_SERVERS_ENV } from "@cognia/agent-acp/devin-mcp-config"
const OWNED_CONFIG_ROOT = Symbol("owned Devin config root")
const ORIGINAL_CONFIG_ROOT = Symbol("original Devin config root")
type PreparedConfig = NodeExternalAgentSpawnConfig & {
  [OWNED_CONFIG_ROOT]?: string
  [ORIGINAL_CONFIG_ROOT]?: string
}
const MAX_JSON_BYTES = DEVIN_MAX_JSON_BYTES
const MAX_COPY_BYTES = 64 * 1_048_576

function readConfig(filename: string): Record<string, unknown> {
  if (!fs.existsSync(filename)) return {}
  const stat = fs.statSync(filename)
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES)
    throw new Error("Invalid Devin MCP configuration")
  return parseDevinJsonc(fs.readFileSync(filename, "utf8"))
}

function assertNoProjectCollision(cwd: string, names: Set<string>): void {
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    for (const name of DEVIN_MCP_CONFIG_FILES) {
      const servers = devinServerMap(readConfig(path.join(current, ".devin", name)))
      if (Object.keys(servers).some((name) => names.has(name))) {
        throw new Error("Project Devin MCP configuration shadows a Cognia session server")
      }
    }
    if (path.dirname(current) === current) break
  }
}

/** Copy configuration rather than symlink it: Devin may migrate or rewrite it. */
function copyPrivate(
  source: string,
  destination: string,
  budget: { bytes: number; files: number },
  ancestors = new Set<string>()
): void {
  const canonical = fs.realpathSync(source)
  if (ancestors.has(canonical)) throw new Error("Devin configuration contains a symlink cycle")
  const stat = fs.statSync(canonical)
  if (++budget.files > 10_000 || (budget.bytes += stat.isFile() ? stat.size : 0) > MAX_COPY_BYTES) {
    throw new Error("Devin configuration exceeds the isolated copy limit")
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: 0o700 })
    const next = new Set(ancestors).add(canonical)
    for (const name of fs.readdirSync(canonical))
      copyPrivate(path.join(canonical, name), path.join(destination, name), budget, next)
  } else if (stat.isFile()) {
    fs.copyFileSync(canonical, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, 0o600)
  } else throw new Error("Devin configuration contains an unsupported file type")
}

export function devinOwnedConfigRoot(config: NodeExternalAgentSpawnConfig): string | undefined {
  return (config as PreparedConfig)[OWNED_CONFIG_ROOT]
}

export function devinOriginalConfigRoot(config: NodeExternalAgentSpawnConfig): string | undefined {
  return (config as PreparedConfig)[ORIGINAL_CONFIG_ROOT]
}

/** Host-owned per-process overlay; the payload and capability never reach the child. */
export function prepareDevinMcpConfig(
  config: NodeExternalAgentSpawnConfig,
  runtime: { home: string; temp: string; xdgConfigHome?: string } = {
    home: os.homedir(),
    temp: os.tmpdir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  }
): { config: NodeExternalAgentSpawnConfig; cleanup: () => void; root?: string } {
  const raw = config.env?.[DEVIN_MCP_SERVERS_ENV]
  if (raw === undefined) return { config, cleanup() {} }
  assertDevinMcpTarget(config.command, config.args)
  const injected = devinInjectedServers(raw)
  assertNoProjectCollision(config.cwd ?? process.cwd(), new Set(Object.keys(injected)))
  const original = runtime.xdgConfigHome || path.join(runtime.home, ".config")
  const botIsolation = config.env?.COGNIA_BOT_ISOLATION === "1"
  if (botIsolation) {
    const state = config.env?.COGNIA_BOT_STATE_DIR
    if (!state || !path.isAbsolute(state))
      throw new Error("Bot isolation requires an owned state directory")
    const credential = path.join(runtime.home, ".local/share/devin/credentials.toml")
    const destination = path.join(state, "data/devin/credentials.toml")
    if (fs.existsSync(credential) && !fs.existsSync(destination)) {
      if (!fs.lstatSync(credential).isFile())
        throw new Error("Devin credential must be a regular file")
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.copyFileSync(credential, destination, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(destination, 0o600)
    }
  }
  if (!path.isAbsolute(original)) throw new Error("Devin XDG_CONFIG_HOME must be absolute")
  const root = fs.realpathSync(fs.mkdtempSync(path.join(runtime.temp, "cognia-devin-config-")))
  fs.chmodSync(root, 0o700)
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true })
  try {
    if (fs.existsSync(original)) {
      for (const name of fs.readdirSync(original)) {
        if (name === "devin" && botIsolation) {
          const source = path.join(original, "devin/config.json")
          const current = readConfig(source)
          const selected = devinIsolatedPrimaryConfig(current)
          fs.mkdirSync(path.join(root, "devin"), { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(root, "devin/config.json"), JSON.stringify(selected), {
            mode: 0o600,
          })
        } else if (name === "devin")
          copyPrivate(path.join(original, name), path.join(root, name), { bytes: 0, files: 0 })
        else if (!botIsolation) fs.symlinkSync(path.join(original, name), path.join(root, name))
      }
    }
    const directory = path.join(root, "devin")
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const filename = path.join(directory, "mcp_config.json")
    const dedicated = readConfig(filename)
    const primaryFile = path.join(directory, "config.json")
    const primary = readConfig(primaryFile)
    const projected = projectDevinMcpConfig(primary, dedicated, injected, original, botIsolation)
    if (botIsolation)
      fs.writeFileSync(primaryFile, JSON.stringify(projected.primary), { mode: 0o600 })
    fs.writeFileSync(filename, JSON.stringify(projected.dedicated), {
      mode: 0o600,
    })
    fs.chmodSync(filename, 0o600)
    const env: Record<string, string> = { ...config.env, XDG_CONFIG_HOME: root }
    delete env[DEVIN_MCP_SERVERS_ENV]
    const prepared: PreparedConfig = {
      ...config,
      env,
      [OWNED_CONFIG_ROOT]: root,
      [ORIGINAL_CONFIG_ROOT]: fs.existsSync(original) ? original : undefined,
    }
    return { config: prepared, cleanup, root }
  } catch (error) {
    cleanup()
    throw error
  }
}
