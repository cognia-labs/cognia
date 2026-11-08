/**
 * Plugin network egress allowlist — renderer/browser-path enforcement.
 *
 * The desktop (Tauri) path already enforces a per-plugin egress allowlist in
 * Rust (`src-tauri/src/plugin_api/mod.rs:network_host_allowed`). In web and
 * mobile (Capacitor) mode there is no Rust host, so `ctx.network` fetches go
 * straight to the browser `fetch()`. This module mirrors the Rust matcher
 * exactly so the same `manifest.networkAccess.allowedDomains` clamp applies on
 * every platform, closing the web/mobile exfiltration hole.
 *
 * Keep the matching semantics in lockstep with the Rust implementation:
 *   - host is trimmed, trailing dots stripped, lowercased; empty host → deny
 *   - a plugin with no `allowedDomains` declaration is DENIED (fail-closed)
 *     under every posture — a `network:fetch` grant alone no longer implies
 *     unrestricted egress; `["*"]` is the explicit opt-in
 *   - `["*"]` allows any host
 *   - `["none"]`, `[]`, or only-blank entries deny all
 *   - otherwise the host must equal, or be a subdomain of, an entry
 */

import { evaluateFetchTarget } from "@cognia/network-guard"

/** Host security posture (see `pluginSecurityPosture` setting). */
export type PluginSecurityPosture = "strict" | "balanced"

/** The `manifest.networkAccess` block (subset this module cares about). */
export interface NetworkAllowlist {
  allowedDomains?: string[]
  reasoning?: string
  rules?: NetworkAccessRule[]
  literalCredentials?: "observe" | "inspect"
}

export type NetworkHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"

/** A least-privilege network rule declared by a plugin manifest. */
export interface NetworkAccessRule {
  /** Host suffix (`example.com` includes `api.example.com`) or `*`. */
  domain: string
  /** HTTP methods this rule admits. An empty list admits nothing. */
  methods: NetworkHttpMethod[]
  /** URL pathname globs. `*` matches within and across path segments. */
  paths: string[]
  /** Defaults to HTTPS when omitted. */
  protocols?: Array<"http" | "https">
  /** Defaults to the selected protocol's standard port when omitted. */
  ports?: number[]
}

export type EgressReason =
  | "no-declaration"
  | "strict-no-declaration"
  | "wildcard"
  | "host-match"
  | "host-denied"
  | "bad-url"
  | "bad-scheme"
  | "private-host"
  | "protocol-denied"
  | "port-denied"

export interface EgressDecision {
  allowed: boolean
  reason: EgressReason
}

/**
 * Mirror of the Rust `network_host_allowed` matcher. `host` must equal, or be a
 * subdomain of, one of the (non-blank, non-"none") `patterns`; `"*"` allows any.
 */
export function matchHost(host: string, patterns: string[]): boolean {
  const h = host.trim().replace(/\.+$/, "").toLowerCase()
  if (!h) return false
  if (patterns.some((entry) => entry.trim() === "*")) return true
  return patterns.some((entry) => {
    const e = entry.trim().replace(/^\.+/, "").toLowerCase()
    return e.length > 0 && e !== "none" && (h === e || h.endsWith(`.${e}`))
  })
}

/** Whether a pathname admitted by `next` escapes the union of `previous` globs. */
function pathScopeWidened(next: string[], previous: string[]): boolean {
  // A glob is a small NFA: '*' consumes any character or advances without
  // consuming one. Walk pairs of state sets to test language containment.
  const patterns = [...next, ...previous]
  const offsets: number[] = []
  const tokens: Array<string | undefined> = []
  for (const pattern of patterns) {
    offsets.push(tokens.length)
    tokens.push(...pattern, undefined)
  }
  const closure = (states: Iterable<number>): number[] => {
    const result = new Set(states)
    for (const state of result) if (tokens[state] === "*") result.add(state + 1)
    return [...result].sort((a, b) => a - b)
  }
  const advance = (states: number[], char: string): number[] =>
    closure(
      states.flatMap((state) =>
        tokens[state] === "*" ? [state] : tokens[state] === char ? [state + 1] : []
      )
    )
  const accepts = (states: number[]) => states.some((state) => tokens[state] === undefined)
  const alphabet = [
    ...new Set(tokens.filter((token): token is string => token !== undefined && token !== "*")),
  ]
  let other = "\u0000"
  while (alphabet.includes(other)) other += "\u0000"
  alphabet.push(other)
  // URL pathnames always begin with '/'.
  const pending = [
    [
      advance(closure(offsets.slice(0, next.length)), "/"),
      advance(closure(offsets.slice(next.length)), "/"),
    ],
  ]
  const visited = new Set<string>()
  for (const [offered, granted] of pending) {
    const key = `${offered.join(",")}|${granted.join(",")}`
    if (visited.has(key)) continue
    visited.add(key)
    if (accepts(offered) && !accepts(granted)) return true
    for (const char of alphabet) {
      const following = advance(offered, char)
      if (following.length) pending.push([following, advance(granted, char)])
    }
  }
  return false
}

interface NetworkGrant {
  domain: string
  method: NetworkHttpMethod
  protocol: "http" | "https"
  port?: number
  paths: string[]
}

function normalizeNetworkDomain(domain: string): string {
  const trimmed = domain.trim()
  const normalized = trimmed.replace(/^\.+/, "").toLowerCase()
  // Only a literal '*' grants every host; trailing-dot entries cannot
  // match a hostname after matchHost strips that hostname's trailing dots.
  return (normalized === "*" && trimmed !== "*") || normalized.endsWith(".") ? "" : normalized
}

function hostScopeWidened(current: string[] | undefined, next: string[] | undefined): boolean {
  const domains = (current ?? [])
    .map(normalizeNetworkDomain)
    .filter((domain) => domain && domain !== "none")
  return (next ?? [])
    .map(normalizeNetworkDomain)
    .some(
      (domain) =>
        domain &&
        domain !== "none" &&
        (domain === "*" ? !domains.includes("*") : !matchHost(domain, domains))
    )
}

function networkGrants(access: NetworkAllowlist | undefined): NetworkGrant[] {
  const domains = (access?.allowedDomains ?? access?.rules?.map((rule) => rule.domain) ?? [])
    .map(normalizeNetworkDomain)
    .filter((domain) => domain && domain !== "none")
  const methods: NetworkHttpMethod[] = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
  const rules: NetworkAccessRule[] =
    access?.rules ??
    domains.map((domain) => ({
      domain,
      methods,
      paths: ["*"],
      protocols: ["http", "https"],
    }))
  const grants: NetworkGrant[] = []
  for (const rule of rules) {
    const domain = normalizeNetworkDomain(rule.domain)
    if (!domain || domain === "none") continue
    for (const clamp of domains) {
      const intersection =
        domain === "*" || matchHost(clamp, [domain])
          ? clamp
          : clamp === "*" || matchHost(domain, [clamp])
            ? domain
            : undefined
      if (!intersection) continue
      for (const method of rule.methods) {
        for (const protocol of rule.protocols ?? ["https"]) {
          const ports =
            access?.rules === undefined
              ? [undefined]
              : (rule.ports ?? [protocol === "https" ? 443 : 80])
          for (const port of ports)
            grants.push({ domain: intersection, method, protocol, port, paths: rule.paths })
        }
      }
    }
  }
  return grants
}

/** Compare effective domain, method, path, protocol and port authority. */
export function hasNetworkAccessWidened(
  current: NetworkAllowlist | undefined,
  next: NetworkAllowlist | undefined
): boolean {
  if (
    current?.literalCredentials === "inspect" &&
    (next?.literalCredentials ?? "observe") === "observe"
  )
    return true
  // Host tools use the effective domain list without request rules. Webview
  // CSP uses only the explicit list, so gaining one is a separate authority.
  if (
    hostScopeWidened(current?.allowedDomains, next?.allowedDomains) ||
    hostScopeWidened(
      current?.allowedDomains ?? current?.rules?.map((rule) => rule.domain),
      next?.allowedDomains ?? next?.rules?.map((rule) => rule.domain)
    )
  )
    return true
  const granted = networkGrants(current)
  return networkGrants(next).some((offer) => {
    const covering = granted.filter(
      (prior) =>
        (prior.domain === "*" ||
          (offer.domain !== "*" && matchHost(offer.domain, [prior.domain]))) &&
        prior.method === offer.method &&
        prior.protocol === offer.protocol &&
        (prior.port === undefined || prior.port === offer.port)
    )
    return pathScopeWidened(
      offer.paths,
      covering.flatMap((prior) => prior.paths)
    )
  })
}

/** Extract a hostname from a URL string; `null` when it cannot be parsed. */
export function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * Decide whether `url` is a permitted egress target for a plugin whose manifest
 * declared `networkAccess`. Pure — returns a decision, never throws.
 */
export function evaluateEgress(
  url: string,
  networkAccess: NetworkAllowlist | undefined,
  posture: PluginSecurityPosture = "balanced"
): EgressDecision {
  const target = evaluateFetchTarget(url)
  if (!target.allowed) return { allowed: false, reason: target.reason }
  const host = target.host!

  const domains = networkAccess?.allowedDomains ?? networkAccess?.rules?.map((rule) => rule.domain)
  if (!domains) {
    // No declaration: deny under every posture (fail-closed) — matches the
    // Rust host gate and the webview CSP. `["*"]` is the explicit opt-in to
    // unrestricted egress.
    return posture === "strict"
      ? { allowed: false, reason: "strict-no-declaration" }
      : { allowed: false, reason: "no-declaration" }
  }

  if (domains.some((entry) => entry.trim() === "*")) {
    return { allowed: true, reason: "wildcard" }
  }

  return matchHost(host, domains)
    ? { allowed: true, reason: "host-match" }
    : { allowed: false, reason: "host-denied" }
}

function wildcardPathMatches(pathname: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(pathname)
}

/**
 * Decide whether a request is admitted by the optional method/path rules.
 * Legacy manifests without `rules` retain their domain-only behavior.
 */
export function evaluateNetworkRequest(
  url: string,
  method: NetworkHttpMethod,
  networkAccess: NetworkAllowlist | undefined,
  posture: PluginSecurityPosture = "balanced"
): EgressDecision & { rule?: NetworkAccessRule } {
  const domainDecision = evaluateEgress(url, networkAccess, posture)
  if (!domainDecision.allowed) return domainDecision

  const rules = networkAccess?.rules
  if (rules === undefined) return domainDecision

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: "bad-url" }
  }

  const requestRules = rules.filter(
    (candidate) =>
      matchHost(parsed.hostname, [candidate.domain]) &&
      candidate.methods.includes(method) &&
      candidate.paths.some((pattern) => wildcardPathMatches(parsed.pathname, pattern))
  )
  if (!requestRules.length) return { allowed: false, reason: "host-denied" }
  const protocol = parsed.protocol.slice(0, -1) as "http" | "https"
  const protocolRules = requestRules.filter((candidate) =>
    (candidate.protocols ?? ["https"]).includes(protocol)
  )
  if (!protocolRules.length) return { allowed: false, reason: "protocol-denied" }
  const port = parsed.port ? Number(parsed.port) : protocol === "https" ? 443 : 80
  const rule = protocolRules.find((candidate) =>
    (candidate.ports ?? [protocol === "https" ? 443 : 80]).includes(port)
  )
  return rule
    ? { allowed: true, reason: "host-match", rule }
    : { allowed: false, reason: "port-denied" }
}

/** Thrown by {@link assertEgressAllowed} when an egress target is not allowed. */
export class PluginEgressError extends Error {
  readonly pluginId: string
  readonly url: string
  readonly host: string
  readonly reason: EgressReason

  constructor(pluginId: string, url: string, host: string, reason: EgressReason) {
    super(`network egress to ${host} is not in plugin ${pluginId}'s allowedDomains`)
    this.name = "PluginEgressError"
    this.pluginId = pluginId
    this.url = url
    this.host = host
    this.reason = reason
  }
}

export class PluginNetworkPolicyError extends PluginEgressError {
  readonly method: NetworkHttpMethod

  constructor(pluginId: string, url: string, method: NetworkHttpMethod, reason: EgressReason) {
    super(pluginId, url, hostFromUrl(url) ?? url, reason)
    this.name = "PluginNetworkPolicyError"
    this.method = method
    this.message = `network policy denied ${method} ${url} for plugin ${pluginId}`
  }
}

/**
 * Enforce the egress allowlist for a renderer-side plugin fetch. Throws
 * {@link PluginEgressError} when the target host is not permitted.
 */
export function assertEgressAllowed(
  pluginId: string,
  url: string,
  networkAccess: NetworkAllowlist | undefined,
  posture: PluginSecurityPosture = "balanced"
): void {
  const decision = evaluateEgress(url, networkAccess, posture)
  if (!decision.allowed) {
    throw new PluginEgressError(pluginId, url, hostFromUrl(url) ?? url, decision.reason)
  }
}

/** Enforce domain plus optional HTTP method/path rules for one request. */
export function assertNetworkRequestAllowed(
  pluginId: string,
  url: string,
  method: NetworkHttpMethod,
  networkAccess: NetworkAllowlist | undefined,
  posture: PluginSecurityPosture = "balanced"
): void {
  const decision = evaluateNetworkRequest(url, method, networkAccess, posture)
  if (!decision.allowed) {
    if (networkAccess?.rules !== undefined && evaluateEgress(url, networkAccess, posture).allowed) {
      throw new PluginNetworkPolicyError(pluginId, url, method, decision.reason)
    }
    throw new PluginEgressError(pluginId, url, hostFromUrl(url) ?? url, decision.reason)
  }
}
