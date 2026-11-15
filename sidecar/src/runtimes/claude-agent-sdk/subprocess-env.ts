import type { SendOptions } from "../../shared/wire/inbound.ts"
// Allowlisted subprocess base environment (ADR-0090 Phase 3).
//
// The Claude Code subprocess must never inherit ambient provider routing or
// credentials from the parent process: a stray ANTHROPIC_BASE_URL or
// OPENAI_API_KEY in the desktop app's env would silently redirect or
// re-credential an agent session. The subprocess env is therefore REBUILT
// from an explicit allowlist and the spec-approved `sendOptions.env` overlay;
// session credentials reach Claude Code only through that overlay.
//
// The allowlist and strip classes themselves live in
// src/platform/process/env.ts, shared with the sandboxed tool processes.

import { ENV_ALLOWLIST } from "../../platform/process/env.ts"
import { unattendedRetryPolicy } from "./runtime-policy.ts"

const PROXY_ENV_RE = /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i
const MANAGED_PROXY_MARKER = "COGNIA_MANAGED_NETWORK_PROXY"

/**
 * OTel variables propagated to the Claude Code subprocess so its spans land in
 * the same collector as the sidecar's, under one trace.
 *
 * These are NOT in the ENV_ALLOWLIST, and that is the point. `OTEL_*` and
 * `CLAUDE_*` are both stripped from the ambient parent env, so a developer's
 * shell exporting `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` cannot silently start
 * shipping a user's agent traces somewhere. Propagation happens only through
 * {@link childTelemetryEnv}, and only when THIS process was itself configured
 * with an endpoint — the same "no endpoint means completely silent" rule
 * `initializeTelemetry` follows.
 *
 * `OTEL_EXPORTER_OTLP_HEADERS` is included because it is how a collector is
 * authenticated; without it the child exports and is rejected, which looks
 * exactly like telemetry being off. It travels no further than the subprocess
 * env — never into the resolved spec, the event log, or a span
 * (ADR-0090 constraint 4).
 */
export const CHILD_TELEMETRY_ENV = [
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_LOG_USER_PROMPTS",
]

/**
 * Build the OTel env for the Claude Code subprocess.
 *
 * Returns `{}` unless the sidecar itself has a traces endpoint configured, so
 * enabling child telemetry is a single decision made in one place rather than
 * two switches that can disagree.
 *
 * `CLAUDE_CODE_ENABLE_TELEMETRY` and `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` are
 * what the CLI reads to turn its own emission on. The enhanced flag is opt-in
 * per send (`sendOptions.telemetry.enhanced`) and NOT derived from the parent,
 * because it widens what the child records.
 *
 * `OTEL_LOG_USER_PROMPTS` is force-set to `0`, never inherited: the sidecar's
 * own spans are built with `recordInputs: false` / `recordOutputs: false`, and
 * a child that logged prompt bodies would break that contract from the other
 * end while looking like the same configuration.
 *
 */
export function childTelemetryEnv(
  sendOptions: SendOptions | undefined,
  parentEnv = process.env
): Record<string, string> {
  if (sendOptions?.telemetry?.child === false) return {}
  if (!parentEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return {}

  const out: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: "1" }
  for (const name of CHILD_TELEMETRY_ENV) {
    const value = parentEnv[name]
    if (typeof value === "string" && value !== "") out[name] = value
  }
  if (sendOptions?.telemetry?.enhanced === true) {
    out.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = "1"
  }
  // Force-set last so an inherited value cannot re-enable prompt logging.
  out.OTEL_LOG_USER_PROMPTS = "0"
  return out
}

/**
 * Build the subprocess env for a send.
 *
 * Allowlisted parent vars + child telemetry + the `sendOptions.env` overlay.
 * Provider credentials remain spec-authoritative, while network proxy vars
 * come only from a Rust-host-marked process policy; the renderer cannot
 * introduce a per-session proxy override. On macOS, Claude's hard-coded /tmp
 * base is redirected to the app's writable per-user temp directory; an
 * explicit session overlay remains authoritative.
 *
 * The telemetry block sits BETWEEN the allowlist and the overlay: it is a host
 * decision, so it beats whatever leaked through the allowlist, and the
 * spec-approved overlay still beats it — a resolver that deliberately sets an
 * OTel variable stays authoritative. The managed proxy block is applied last
 * because routing is a host policy rather than a session credential.
 *
 */
export function buildSubprocessEnv(
  sendOptions: SendOptions | undefined,
  parentEnv = process.env
): NodeJS.ProcessEnv {
  const retry = unattendedRetryPolicy(sendOptions)
  const retryEnv: NodeJS.ProcessEnv = retry
    ? {
        CLAUDE_CODE_RETRY_WATCHDOG: "1",
        CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: String(retry.maxWaitMs),
        ...(retry.usageLimitRecheckMs === undefined
          ? {}
          : {
              CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS: String(retry.usageLimitRecheckMs),
            }),
      }
    : {}
  // Raw env input must not enable, extend or tune hidden retries around the
  // typed policy and the sidecar's independent wall-clock deadline.
  const stripRetry = (env: NodeJS.ProcessEnv) =>
    Object.fromEntries(
      Object.entries(env).filter(([name]) => !/^CLAUDE_CODE_RETRY_WATCHDOG/i.test(name))
    )
  parentEnv = stripRetry(parentEnv)
  const rawOverlay = stripRetry(sendOptions?.env ?? {})
  const claudeTempEnv =
    process.platform === "darwin" && typeof parentEnv.TMPDIR === "string" && parentEnv.TMPDIR !== ""
      ? { CLAUDE_CODE_TMPDIR: parentEnv.TMPDIR }
      : {}
  // The renderer is not allowed to select a one-off proxy or shuttle proxy
  // credentials back into the sidecar. Only the Rust host can mark the
  // process-level proxy env as managed; those values then apply to every
  // frozen execution and override any renderer-provided proxy keys.
  const overlay = Object.fromEntries(
    Object.entries(rawOverlay).filter(([name]) => !PROXY_ENV_RE.test(name))
  )
  const managedProxy: NodeJS.ProcessEnv = {}
  if (parentEnv[MANAGED_PROXY_MARKER] === "1") {
    for (const [name, value] of Object.entries(parentEnv)) {
      if (PROXY_ENV_RE.test(name) && typeof value === "string" && value !== "") {
        managedProxy[name] = value
      }
    }
  }
  const base: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(parentEnv)) {
    if (!ENV_ALLOWLIST.has(name)) continue
    const value = parentEnv[name]
    if (typeof value === "string") base[name] = value
  }
  return {
    ...base,
    ...childTelemetryEnv(sendOptions, parentEnv),
    ...claudeTempEnv,
    ...overlay,
    ...managedProxy,
    ...retryEnv,
  }
}

/**
 * Route-derived env additions (ADR-0090): a gateway-routed spec injects ONLY
 * the local endpoint + the ticket secret (which the caller placed into
 * `sendOptions.env.ANTHROPIC_API_KEY`); a direct spec passes through the
 * ephemeral credentials already resolved into `sendOptions.env`. This helper
 * validates the invariant rather than adding values: a gateway route whose
 * overlay smuggles a non-local ANTHROPIC_BASE_URL is a spec violation.
 *
 */
export function validateRouteEnv(sendOptions: SendOptions | undefined) {
  const execution = sendOptions?.execution
  if (!execution) return { ok: true }
  if (execution.route?.kind !== "gateway") return { ok: true }
  const overlayBase = sendOptions?.env?.ANTHROPIC_BASE_URL
  if (overlayBase && overlayBase !== execution.route.endpoint) {
    return {
      ok: false,
      reason: `gateway route env mismatch: ANTHROPIC_BASE_URL must be the ticket endpoint`,
    }
  }
  return { ok: true }
}
