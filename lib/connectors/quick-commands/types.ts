/**
 * Cross-adapter quick-command schema. `triggerKey` is the platform-side
 * identity — the Feishu bot-menu `event_key`, or the `key` of a WeCom
 * `template_card` button. The platform/menu a command lives on is implicit
 * in the adapter that holds the commands list: Lark rows sit on Lark adapter
 * settings, WeCom rows on WeCom adapter settings.
 */

export type IMQuickCommandActionType = "prompt" | "slash" | "link"

export interface IMQuickCommandAction {
  type: IMQuickCommandActionType
  /**
   * Prompt text, a slash-command line (e.g. "/agenda today"), or — for
   * `link` — an app-relative path (e.g. "/") resolved against the
   * configured web entry base at reply time. Link commands never run an
   * AI turn; the adapter replies with the resolved URL (plan 2026-07-24
   * P4.2).
   */
  value: string
}

export interface IMQuickCommand {
  /** The platform-side trigger key — Feishu `event_key` / WeCom button `key`. */
  triggerKey: string
  /** Optional human label for the Settings UI. */
  label?: string
  action: IMQuickCommandAction
}

function isQuickCommandActionType(value: unknown): value is IMQuickCommandActionType {
  return value === "prompt" || value === "slash" || value === "link"
}

export function isIMQuickCommand(row: unknown): row is IMQuickCommand {
  if (!row || typeof row !== "object") return false
  const r = row as Record<string, unknown>
  if (typeof r.triggerKey !== "string") return false
  const action = r.action as Record<string, unknown> | undefined
  if (!action || typeof action !== "object") return false
  return isQuickCommandActionType(action.type) && typeof action.value === "string"
}

/**
 * Return a canonical `IMQuickCommand` row. Drops malformed rows by returning
 * null — callers filter the result.
 */
export function normalizeQuickCommand(row: unknown): IMQuickCommand | null {
  if (!isIMQuickCommand(row)) return null
  return {
    triggerKey: row.triggerKey,
    label: row.label,
    action: { type: row.action.type, value: row.action.value },
  }
}

/**
 * Normalize an unknown input array into a canonical IMQuickCommand list,
 * silently dropping malformed entries. Used by adapter init code where
 * `settings.quickCommands` is a JSON column.
 */
export function normalizeQuickCommandList(input: unknown): IMQuickCommand[] {
  if (!Array.isArray(input)) return []
  const out: IMQuickCommand[] = []
  for (const row of input) {
    const normalized = normalizeQuickCommand(row)
    if (normalized) out.push(normalized)
  }
  return out
}
