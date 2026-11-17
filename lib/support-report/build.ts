/**
 * Assemble a support report from the chosen sections.
 *
 * Every piece of text that reaches the report — header values, section
 * headings, section bodies (including the user's own words) and the title —
 * goes through `redactText` and is then re-checked with `hasNoLeakingPii`.
 * The finished Markdown is scanned once more as a whole. Anything that still
 * leaks after redaction fails the whole build rather than shipping a
 * partially-scrubbed document: the caller shows an error, nothing leaves the
 * device.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { APP_VERSION } from "@/lib/app-version"

import { listAvailableSupportReportSections } from "./sections"
import type { SupportReport, SupportReportContext, SupportReportSectionSpec } from "./types"

/** Per-section cap so one runaway dump (a 200k stack) cannot crowd out the rest. */
export const MAX_SECTION_CHARS = 8_000
const MAX_TITLE_CHARS = 100
/** Header values are short identifiers (route, locale, error digest). */
const MAX_HEADER_VALUE_CHARS = 300

export interface BuildSupportReportOptions {
  context: SupportReportContext
  /**
   * Section ids to include. Pinned sections are always included regardless of
   * this list; unknown ids are ignored. Defaults to every available section.
   */
  sectionIds?: readonly string[]
  /** Injected for tests; production uses the registry. */
  sections?: readonly SupportReportSectionSpec[]
  /** ISO timestamp — injected so tests are deterministic. */
  generatedAt?: string
}

/** Sanitise a free-text fragment: redact, cap, and refuse to leak. */
function scrub(text: string, cap: number): string {
  const redacted = redactText(text).redacted.slice(0, cap)
  if (!hasNoLeakingPii(redacted)) {
    throw new Error("Support report still contains sensitive data after redaction.")
  }
  return redacted
}

/** Issue title: the failure if we have one, else the first line of the description. */
export function deriveSupportReportTitle(ctx: SupportReportContext): string {
  const tag = ctx.category ?? ctx.diagnostic?.source ?? ctx.surface
  if (ctx.error?.message) return `[${tag}] ${ctx.error.message}`.slice(0, MAX_TITLE_CHARS)
  if (ctx.diagnostic?.code) return `[${tag}] ${ctx.diagnostic.code}`.slice(0, MAX_TITLE_CHARS)
  const firstLine = ctx.description?.trim().split(/\r?\n/, 1)[0]?.trim()
  if (firstLine) return firstLine.slice(0, MAX_TITLE_CHARS)
  return "Cognia support report"
}

export async function buildSupportReport({
  context,
  sectionIds,
  sections = listAvailableSupportReportSections(context),
  generatedAt = new Date().toISOString(),
}: BuildSupportReportOptions): Promise<SupportReport> {
  const wanted = sectionIds ? new Set(sectionIds) : null
  const chosen = sections.filter(
    (section) =>
      section.isAvailable(context) && (section.pinned || !wanted || wanted.has(section.id))
  )

  const headerLine = (label: string, value: string | null | undefined) =>
    value ? [`- ${label}: ${scrub(value, MAX_HEADER_VALUE_CHARS)}`] : []
  const header = [
    "## Cognia support report",
    "",
    `- App version: ${APP_VERSION}`,
    `- Generated: ${generatedAt}`,
    ...headerLine("Surface", context.surface),
    ...headerLine("Category", context.category),
    ...headerLine("Route", context.route),
    ...headerLine("Locale", context.locale),
    ...headerLine("Error ID", context.error?.digest),
  ]

  const bodies: string[] = []
  const sectionIdsOut: string[] = []
  for (const section of chosen) {
    const raw = await section.collect(context)
    if (!raw || raw.trim().length === 0) continue
    bodies.push(
      `### ${scrub(section.heading, MAX_HEADER_VALUE_CHARS)}`,
      "",
      scrub(raw, MAX_SECTION_CHARS),
      ""
    )
    sectionIdsOut.push(section.id)
  }

  const markdown = [...header, "", ...bodies].join("\n").trimEnd() + "\n"
  // Fail closed on the assembled document too: joining fragments must not
  // recombine into something the per-fragment checks missed.
  if (!hasNoLeakingPii(markdown)) {
    throw new Error("Support report still contains sensitive data after redaction.")
  }
  return {
    title: scrub(deriveSupportReportTitle(context), MAX_TITLE_CHARS),
    markdown,
    filename: `cognia-support-report-${generatedAt.slice(0, 10)}.md`,
    generatedAt,
    sectionIds: sectionIdsOut,
  }
}
