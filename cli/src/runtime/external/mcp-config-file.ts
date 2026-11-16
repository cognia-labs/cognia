/**
 * Private per-process MCP configuration for an engine that reads its MCP
 * servers only from its own files (`EngineMcpConfigFile`, ADR-0217), the twin
 * of `crates/cognia-external-agent/src/mcp_config_file.rs`. Each session's
 * servers are projected into a copied configuration root for deterministic
 * discovery and isolation; originals are never changed. Nothing here names
 * an engine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { EngineMcpConfigFile } from "@cognia/agent-contracts/engine-launch"
import { ENGINE_MCP_SERVERS_ENV } from "@cognia/agent-contracts/engine-launch"
import { isIsolatedLaunch } from "@cognia/agent-contracts/engine-launch-profile"

import { mcpConfigFile } from "./launch-descriptor"
import type { NodeExternalAgentSpawnConfig } from "./node-backend"

export { ENGINE_MCP_SERVERS_ENV }

const MAX_JSON_BYTES = 1_048_576
const MAX_COPY_BYTES = 64 * MAX_JSON_BYTES
const UNSUPPORTED = "This launch does not take MCP servers in its configuration files"
const OVERLAY = Symbol("engine MCP configuration overlay")

/** The overlay a prepared launch owns; never read from a caller's config. */
export interface McpConfigOverlay {
  /** The private root the engine's `rootEnv` points at. */
  root: string
  rootEnv: string
  /** The person's own root, which the owner's launch reads. */
  original?: string
  private: boolean
}

type PreparedConfig = NodeExternalAgentSpawnConfig & { [OVERLAY]?: McpConfigOverlay }

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

class InvalidMcpConfiguration extends Error {
  constructor(id: string) {
    super(`Invalid MCP configuration for ${id}`)
  }
}

/** A bounded JSONC object, without rewriting comment-like text or commas inside strings. */
export function parseJsonc(raw: string): Record<string, unknown> {
  const invalid = () => new Error("not a valid bounded JSONC object")
  if (new TextEncoder().encode(raw).length > MAX_JSON_BYTES) throw invalid()
  let text = ""
  let string = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (string) {
      text += ch
      if (ch === "\\") text += raw[++i] ?? ""
      else if (ch === '"') string = false
    } else if (ch === '"') {
      string = true
      text += ch
    } else if (ch === "/" && raw[i + 1] === "/") {
      while (i + 1 < raw.length && raw[i + 1] !== "\n") i++
      text += " "
    } else if (ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2)
      if (end < 0) throw invalid()
      i = end + 1
      text += " "
    } else text += ch
  }
  let cleaned = ""
  string = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (string) {
      cleaned += ch
      if (ch === "\\") cleaned += text[++i] ?? ""
      else if (ch === '"') string = false
    } else if (ch === '"') {
      string = true
      cleaned += ch
    } else if (ch !== "," || !/^\s*[}\]]/.test(text.slice(i + 1))) cleaned += ch
  }
  let value: unknown
  try {
    value = JSON.parse(cleaned)
  } catch {
    throw invalid()
  }
  if (!isObject(value)) throw invalid()
  return value
}

function readConfig(id: string, filename: string): Record<string, unknown> {
  if (!fs.existsSync(filename)) return {}
  const stat = fs.statSync(filename)
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new InvalidMcpConfiguration(id)
  try {
    return parseJsonc(fs.readFileSync(filename, "utf8"))
  } catch {
    throw new InvalidMcpConfiguration(id)
  }
}

function serverMap(id: string, config: Record<string, unknown>): Record<string, unknown> {
  if (config.mcpServers === undefined) return {}
  if (!isObject(config.mcpServers)) throw new InvalidMcpConfiguration(id)
  return config.mcpServers
}

function pairs(id: string, value: unknown): Record<string, string> {
  if (!Array.isArray(value) || value.length > 256) throw new InvalidMcpConfiguration(id)
  const entries = value.map((entry) => {
    if (
      !isObject(entry) ||
      typeof entry.name !== "string" ||
      !entry.name ||
      typeof entry.value !== "string" ||
      entry.name.includes("\0") ||
      entry.value.includes("\0")
    )
      throw new InvalidMcpConfiguration(id)
    return [entry.name, entry.value] as [string, string]
  })
  if (new Set(entries.map(([name]) => name)).size !== entries.length)
    throw new InvalidMcpConfiguration(id)
  return Object.fromEntries(entries)
}

/** The session's ACP `McpServer[]` as an `mcpServers` map. */
export function injectedServers(id: string, raw: string): Record<string, unknown> {
  const fail = (): never => {
    throw new InvalidMcpConfiguration(id)
  }
  if (new TextEncoder().encode(raw).length > MAX_JSON_BYTES) fail()
  let values: unknown
  try {
    values = JSON.parse(raw)
  } catch {
    fail()
  }
  if (!Array.isArray(values) || values.length > 64) fail()
  const entries = (values as unknown[]).map((value): [string, unknown] => {
    if (
      !isObject(value) ||
      typeof value.name !== "string" ||
      !value.name ||
      value.name.length > 256 ||
      value.name.includes("\0")
    )
      fail()
    const server = value as Record<string, unknown> & { name: string }
    if (server.type === "http" || server.type === "sse") {
      if (typeof server.url !== "string") fail()
      let url: URL | undefined
      try {
        url = new URL(server.url as string)
      } catch {
        fail()
      }
      if (!["http:", "https:"].includes(url!.protocol) || !url!.hostname) fail()
      if (Object.keys(server).some((key) => !["name", "type", "url", "headers"].includes(key)))
        fail()
      return [
        server.name,
        { url: server.url, transport: server.type, headers: pairs(id, server.headers ?? []) },
      ]
    }
    if (server.type !== undefined && server.type !== "stdio") fail()
    if (
      Object.keys(server).some((key) => !["name", "type", "command", "args", "env"].includes(key))
    )
      fail()
    if (
      typeof server.command !== "string" ||
      !server.command.trim() ||
      server.command.includes("\0") ||
      !Array.isArray(server.args) ||
      server.args.length > 512 ||
      server.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    )
      fail()
    return [
      server.name,
      { command: server.command, args: server.args, env: pairs(id, server.env ?? []) },
    ]
  })
  if (new Set(entries.map(([name]) => name)).size !== entries.length) fail()
  return Object.fromEntries(entries)
}

function dottedScalar(map: Record<string, unknown>, dotted: string): unknown {
  let value: unknown = map
  for (const part of dotted.split(".")) {
    if (!isObject(value)) return undefined
    value = value[part]
  }
  return ["string", "number", "boolean"].includes(typeof value) ? value : undefined
}

function setDotted(map: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".")
  let current = map
  for (const part of parts.slice(0, -1)) {
    if (!isObject(current[part])) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

/** What a private launch keeps of the engine's settings. */
export function privateSettings(
  file: EngineMcpConfigFile,
  current: Record<string, unknown>
): Record<string, unknown> {
  const selected: Record<string, unknown> = {}
  for (const dotted of file.privateKeep) {
    const value = dottedScalar(current, dotted)
    if (value !== undefined) setDotted(selected, dotted, value)
  }
  for (const [dotted, value] of Object.entries(file.privateSet)) setDotted(selected, dotted, value)
  return selected
}

function assertNoProjectCollision(
  id: string,
  file: EngineMcpConfigFile,
  cwd: string,
  names: Set<string>
): void {
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    for (const name of file.project.files) {
      const servers = serverMap(
        id,
        readConfig(id, path.join(current, file.project.directory, name))
      )
      if (Object.keys(servers).some((server) => names.has(server)))
        throw new Error(`Project ${id} MCP configuration shadows a Cognia session server`)
    }
    if (path.dirname(current) === current) break
  }
}

/** Copy configuration rather than symlink it: the engine may migrate or rewrite it. */
function copyPrivate(
  id: string,
  source: string,
  destination: string,
  budget: { bytes: number; files: number },
  ancestors = new Set<string>()
): void {
  const canonical = fs.realpathSync(source)
  if (ancestors.has(canonical)) throw new Error(`${id} configuration contains a symlink cycle`)
  const stat = fs.statSync(canonical)
  if (++budget.files > 10_000 || (budget.bytes += stat.isFile() ? stat.size : 0) > MAX_COPY_BYTES)
    throw new Error(`${id} configuration exceeds the isolated copy limit`)
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: 0o700 })
    const next = new Set(ancestors).add(canonical)
    for (const name of fs.readdirSync(canonical))
      copyPrivate(id, path.join(canonical, name), path.join(destination, name), budget, next)
  } else if (stat.isFile()) {
    fs.copyFileSync(canonical, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, 0o600)
  } else throw new Error(`${id} configuration contains an unsupported file type`)
}

export function mcpConfigOverlayOf(
  config: NodeExternalAgentSpawnConfig
): McpConfigOverlay | undefined {
  return (config as PreparedConfig)[OVERLAY]
}

/** Host-owned per-process overlay; the payload never reaches the child. */
export function prepareMcpConfigFile(
  config: NodeExternalAgentSpawnConfig,
  runtime: {
    home: string
    temp: string
    hostEnv: Readonly<Record<string, string | undefined>>
  } = { home: os.homedir(), temp: os.tmpdir(), hostEnv: process.env }
): { config: NodeExternalAgentSpawnConfig; cleanup: () => void; root?: string } {
  const raw = config.env?.[ENGINE_MCP_SERVERS_ENV]
  if (raw === undefined) return { config, cleanup() {} }
  const target = mcpConfigFile(config.command, config.args ?? [])
  if (!target) throw new Error(UNSUPPORTED)
  const { id, file } = target
  const injected = injectedServers(id, raw)
  assertNoProjectCollision(id, file, config.cwd ?? process.cwd(), new Set(Object.keys(injected)))
  const original = runtime.hostEnv[file.rootEnv] || path.join(runtime.home, file.rootDefault)
  const isPrivate = isIsolatedLaunch(config.env)
  if (!path.isAbsolute(original)) throw new Error(`${id} ${file.rootEnv} must be absolute`)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(runtime.temp, "cognia-mcp-config-")))
  fs.chmodSync(root, 0o700)
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true })
  try {
    if (fs.existsSync(original)) {
      for (const name of fs.readdirSync(original)) {
        if (name === file.directory && isPrivate) {
          const current = readConfig(id, path.join(original, file.directory, file.settingsFile))
          fs.mkdirSync(path.join(root, file.directory), { recursive: true, mode: 0o700 })
          fs.writeFileSync(
            path.join(root, file.directory, file.settingsFile),
            JSON.stringify(privateSettings(file, current)),
            { mode: 0o600 }
          )
        } else if (name === file.directory)
          copyPrivate(id, path.join(original, name), path.join(root, name), { bytes: 0, files: 0 })
        else if (!isPrivate) fs.symlinkSync(path.join(original, name), path.join(root, name))
      }
    }
    const directory = path.join(root, file.directory)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const serversFile = path.join(directory, file.serversFile)
    const dedicated = readConfig(id, serversFile)
    const settingsFile = path.join(directory, file.settingsFile)
    const settings = readConfig(id, settingsFile)
    if (isPrivate) {
      delete settings.mcpServers
      delete dedicated.mcpServers
      fs.writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 })
    }
    const servers = { ...serverMap(id, settings), ...serverMap(id, dedicated), ...injected }
    for (const server of Object.values(servers)) {
      if (!isObject(server)) throw new InvalidMcpConfiguration(id)
      if (typeof server.command !== "string") continue
      if (
        server.env !== undefined &&
        (!isObject(server.env) ||
          Object.values(server.env).some((value) => typeof value !== "string"))
      )
        throw new InvalidMcpConfiguration(id)
      server.env = { [file.rootEnv]: original, ...(server.env as Record<string, string>) }
    }
    fs.writeFileSync(serversFile, JSON.stringify({ ...dedicated, mcpServers: servers }), {
      mode: 0o600,
    })
    fs.chmodSync(serversFile, 0o600)
    const env: Record<string, string> = { ...config.env, [file.rootEnv]: root }
    delete env[ENGINE_MCP_SERVERS_ENV]
    const prepared: PreparedConfig = {
      ...config,
      env,
      [OVERLAY]: {
        root,
        rootEnv: file.rootEnv,
        ...(fs.existsSync(original) && { original }),
        private: isPrivate,
      },
    }
    return { config: prepared, cleanup, root }
  } catch (error) {
    cleanup()
    throw error
  }
}
