/**
 * Workflow types — definitions only.
 *
 *   • `./visual`     — the n8n-style visual graph editor + execution engine
 *     (consumed by `lib/workflow/`, `components/workflow/`, the Settings
 *     section, and the Tauri-side trigger daemons). Its top-level shape is
 *     exported as `VisualWorkflow`.
 *   • `./conditions` — the condition operators the graph's branch nodes use.
 */

export * from "./visual"
export * from "./conditions"
