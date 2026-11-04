/** Devin configuration format and projection. Filesystem authority belongs to the Host. */
export const DEVIN_MCP_SERVERS_ENV = "COGNIA_DEVIN_MCP_SERVERS"
export const DEVIN_MAX_JSON_BYTES = 1_048_576
const MAX_JSON_BYTES = DEVIN_MAX_JSON_BYTES
export const DEVIN_MCP_CONFIG_FILES = [
  "config.json",
  "config.local.json",
  "mcp_config.json",
  "mcp_config.local.json",
] as const
function fail(): never {
  throw new Error("Invalid Devin MCP configuration")
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** JSONC without rewriting comment-like text or trailing commas inside strings. */
export function parseDevinJsonc(raw: string): Record<string, unknown> {
  if (new TextEncoder().encode(raw).length > MAX_JSON_BYTES) fail()
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
      if (end < 0) fail()
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
    fail()
  }
  if (!object(value)) fail()
  return value
}

export function devinServerMap(config: Record<string, unknown>): Record<string, unknown> {
  if (config.mcpServers === undefined) return {}
  if (!object(config.mcpServers)) fail()
  return config.mcpServers
}

function pairs(value: unknown): Record<string, string> {
  if (!Array.isArray(value) || value.length > 256) fail()
  const entries = value.map((entry) => {
    if (
      !object(entry) ||
      typeof entry.name !== "string" ||
      !entry.name ||
      typeof entry.value !== "string" ||
      entry.name.includes("\0") ||
      entry.value.includes("\0")
    )
      fail()
    return [entry.name, entry.value] as [string, string]
  })
  if (new Set(entries.map(([name]) => name)).size !== entries.length) fail()
  return Object.fromEntries(entries)
}

export function devinInjectedServers(raw: string): Record<string, unknown> {
  if (new TextEncoder().encode(raw).length > MAX_JSON_BYTES) fail()
  let values: unknown
  try {
    values = JSON.parse(raw)
  } catch {
    fail()
  }
  if (!Array.isArray(values) || values.length > 64) fail()
  const entries = values.map((value): [string, unknown] => {
    if (
      !object(value) ||
      typeof value.name !== "string" ||
      !value.name ||
      value.name.length > 256 ||
      value.name.includes("\0")
    )
      fail()
    if (value.type === "http" || value.type === "sse") {
      if (typeof value.url !== "string") fail()
      let url: URL
      try {
        url = new URL(value.url)
      } catch {
        fail()
      }
      if (!["http:", "https:"].includes(url.protocol)) fail()
      if (Object.keys(value).some((key) => !["name", "type", "url", "headers"].includes(key)))
        fail()
      return [
        value.name,
        { url: value.url, transport: value.type, headers: pairs(value.headers ?? []) },
      ]
    }
    if (value.type !== undefined && value.type !== "stdio") fail()
    if (Object.keys(value).some((key) => !["name", "type", "command", "args", "env"].includes(key)))
      fail()
    if (
      typeof value.command !== "string" ||
      !value.command.trim() ||
      value.command.includes("\0") ||
      !Array.isArray(value.args) ||
      value.args.length > 512 ||
      value.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    )
      fail()
    return [value.name, { command: value.command, args: value.args, env: pairs(value.env ?? []) }]
  })
  if (new Set(entries.map(([name]) => name)).size !== entries.length) fail()
  return Object.fromEntries(entries)
}

export function assertDevinMcpTarget(command: string, args: readonly string[] | undefined) {
  if (command.toLowerCase().replace(/\.(exe|cmd|bat)$/, "") !== "devin" || args?.[0] !== "acp")
    fail()
}
export function devinIsolatedPrimaryConfig(
  current: Record<string, unknown>
): Record<string, unknown> {
  const selected: Record<string, unknown> = {}
  if (typeof current.version === "number") selected.version = current.version
  if (object(current.devin) && typeof current.devin.org_id === "string")
    selected.devin = { org_id: current.devin.org_id }
  selected.shell = { setup_complete: true }
  return selected
}
export function projectDevinMcpConfig(
  primary: Record<string, unknown>,
  dedicated: Record<string, unknown>,
  injected: Record<string, unknown>,
  original: string,
  botIsolation: boolean
) {
  const base = { ...primary },
    output = { ...dedicated }
  if (botIsolation) {
    delete base.mcpServers
    delete output.mcpServers
  }
  const servers = { ...devinServerMap(base), ...devinServerMap(output), ...injected }
  for (const server of Object.values(servers)) {
    if (!object(server)) fail()
    if (typeof server.command === "string") {
      if (
        server.env !== undefined &&
        (!object(server.env) ||
          Object.values(server.env).some((value) => typeof value !== "string"))
      )
        fail()
      server.env = {
        XDG_CONFIG_HOME: original,
        ...(server.env as Record<string, string> | undefined),
      }
    }
  }
  return { primary: base, dedicated: { ...output, mcpServers: servers } }
}
