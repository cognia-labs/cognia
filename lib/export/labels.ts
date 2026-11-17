/**
 * Every word an exported conversation is written with (D11): who spoke, the
 * metadata table, the footer and the part labels. The exporters take this
 * resolved object and stay pure and synchronous; callers resolve it once per
 * export in the locale the user reads, from `export.document`.
 */

import { partLabelsFrom, type PartLabels, type PartLabelTranslator } from "@/lib/chat/parts/labels"
import { currentLocale, getRuntimeTranslator } from "@/lib/i18n/runtime-translator"

export interface ExportLabels {
  /** BCP 47 tag the document declares (`<html lang>`). */
  locale: string
  /** Who spoke; an unknown role is shown as stored. */
  role: (role: string) => string
  conversationInfo: string
  property: string
  value: string
  date: string
  kind: string
  model: string
  workingDir: string
  messages: string
  exported: string
  systemPrompt: string
  conversation: string
  tokenUsage: string
  attachedContext: string
  attachedContextOmitted: string
  footer: (date: string) => string
  parts: PartLabels
}

const ROLES = new Set(["user", "assistant", "system"])

/** The labels, read from a translator scoped to `export.document`. */
export function exportLabelsFrom(t: PartLabelTranslator, locale: string): ExportLabels {
  return {
    locale,
    role: (role) => (ROLES.has(role) ? t(`roles.${role}`) : role),
    conversationInfo: t("meta.conversationInfo"),
    property: t("meta.property"),
    value: t("meta.value"),
    date: t("meta.date"),
    kind: t("meta.kind"),
    model: t("meta.model"),
    workingDir: t("meta.workingDir"),
    messages: t("meta.messages"),
    exported: t("meta.exported"),
    systemPrompt: t("meta.systemPrompt"),
    conversation: t("meta.conversation"),
    tokenUsage: t("meta.tokenUsage"),
    attachedContext: t("attachedContext"),
    attachedContextOmitted: t("attachedContextOmitted"),
    footer: (date) => t("footer", { date }),
    parts: partLabelsFrom(t),
  }
}

/** The labels in the locale the UI is showing, for callers outside React. */
export async function loadExportLabels(): Promise<ExportLabels> {
  const [locale, t] = await Promise.all([currentLocale(), getRuntimeTranslator("export.document")])
  return exportLabelsFrom(t, locale)
}
