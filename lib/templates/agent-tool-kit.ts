/**
 * What the template platform's agent tools share with the Squad template
 * tools (ADR-0164): the consent subject every write answers to, the platform
 * a preflight is evaluated for, the listing and read caps, and the structured
 * failures the runners return instead of throwing.
 *
 * Two module families use it: `template_*` / `chat_template_*` here
 * (`./agent-tools.ts`) and `squad_*` in the squads module
 * (`lib/squads/agent-tools.ts`), which builds on templates. Both are switched
 * on by the one setting (`selfInvokeTools.templates`) and ask under the one
 * subject, so a grant the user gave before the tools moved still covers them.
 *
 * ## Why every write goes through the plugin consent broker
 *
 * `ctx.templates` (`lib/plugin/api/templates-api.ts`) asks the user before any
 * library write, and `ctx.team.saveAsTemplate` was retrofitted onto the same
 * prompt after it turned out to be the one way around it. An agent turn is a
 * third caller of the same writes, so it answers to the same broker under its
 * own synthetic subject: `templates:instantiate` for anything that creates a
 * resource from a template and `templates:library:write` for anything that
 * puts a row in the user's library. The manifests declare the tools `allow`
 * so the user is asked once, by the consent overlay, not twice.
 *
 * ## Why the runners never throw
 *
 * The relay turns a rejection into an opaque transport error, whereas a
 * structured `{ok:false, code}` reaches the model as something it can act on.
 */

import type { TemplatePlatform } from "./contracts"
import type { ToolSurfaceContext } from "@/lib/modules/manifest-types"

/**
 * The subject the consent broker records the tools' grants under. It predates
 * the module manifests (whose tools travel as `cognia-<module>-builtin`) and
 * stays, so grants already given keep applying.
 */
export const TEMPLATE_TOOL_CONSENT_SUBJECT = "cognia-template-builtin"

/** The consent permissions a write tool asks the broker for. */
export type TemplateToolConsentPermission = "templates:instantiate" | "templates:library:write"

/** Ceiling on any listing, so a large library cannot flood a turn. */
export const LIST_MAX_ITEMS = 50

/**
 * Payload and body reads are capped. A template payload pasted whole into the
 * context window is a worse answer than a truncated one plus its length, and
 * the cap also bounds what the relay's PII gate has to scan.
 */
export const READ_CONTENT_MAX_CHARS = 8000

/**
 * Whether a send gets the template tools: opted in, and withheld from an
 * IM-bound session and the standalone CLI, where the consent overlay every
 * write asks has no screen to appear on.
 */
export function templateToolsOffered(ctx: ToolSurfaceContext): boolean {
  if (ctx.session?.platformBinding?.adapterId || ctx.host === "cli") return false
  return ctx.settings?.selfInvokeTools?.templates === true
}

/** Ask the user under the tools' subject. Resolves `true` when the write may proceed. */
export async function requestTemplateToolConsent(
  permission: TemplateToolConsentPermission,
  reason: string
): Promise<boolean> {
  const { getPluginConsentBroker } = await import("@/lib/plugin/security/consent-broker")
  return getPluginConsentBroker().request({
    pluginId: TEMPLATE_TOOL_CONSENT_SUBJECT,
    permission,
    reason,
  })
}

/** The platform this device instantiates templates for. */
export async function currentTemplatePlatform(): Promise<TemplatePlatform> {
  const { detectPlatform } = await import("@/lib/platform/detect")
  const platform = detectPlatform()
  return platform === "tauri" ? "desktop" : platform === "mobile" ? "mobile" : "web"
}

export type TemplateToolFailure = {
  ok: false
  code: string
  error: string
  issues?: unknown
}

export function invalidArguments(error: string): TemplateToolFailure {
  return { ok: false, code: "invalid_arguments", error }
}

export function notFound(kind: string, id: string): TemplateToolFailure {
  return { ok: false, code: "not_found", error: `no ${kind} with id ${id}` }
}

export function denied(what: string): TemplateToolFailure {
  return { ok: false, code: "consent_denied", error: `the user declined to ${what}` }
}

/** What a runner returns when something underneath it threw. */
export function toolFailed(err: unknown): TemplateToolFailure {
  return { ok: false, code: "tool_failed", error: err instanceof Error ? err.message : String(err) }
}

/** A non-blank string argument, or `null`. */
export function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === "string" && value.trim() ? value : null
}
