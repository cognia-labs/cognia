/**
 * The words an exported part is drawn with: the headings, the notes that stand
 * where a part is not exported, and the one-line representations of cards that
 * have no text of their own (D11). Resolved by the caller from
 * `export.document.parts` in the locale the user reads, so the part renderers
 * in `./descriptors.ts` stay pure and synchronous.
 */

/** `(key, values) => text`, as `useTranslations` and `getRuntimeTranslator` return it. */
export type PartLabelTranslator = (
  key: string,
  values?: Record<string, string | number | Date>
) => string

export interface PartLabels {
  thinking: string
  tool: (name: string) => string
  toolInput: string
  toolOutput: string
  toolError: string
  /** Used when a file part names neither a file nor a media type. */
  file: string
  /** Used when a source document has no title or media type. */
  source: string
  sources: string
  /** Sources recalled from the user's own material (memory, twin, project). */
  privateSources: (count: number) => string
  artifact: (title: string, kind: string) => string
  canvas: (title: string) => string
  subagent: (name: string, status: string) => string
  /** Stands where an interactive surface was. */
  interactiveSurface: string
  /** Stands where a part with no export representation was. */
  notExported: (type: string) => string
  toolSummary: string
  teamDispatch: (name: string) => string
  squadRun: (name: string) => string
  squadGate: (title: string, decision: string) => string
  verification: (verdict: string) => string
  verificationRunning: string
  verificationFailed: (error: string) => string
  grounding: (supported: number, total: number) => string
  /** Stands where a shared run withheld a part. */
  withheld: string
  /** Stands where the conversation was compacted. */
  compacted: string
}

const GATE_DECISIONS = new Set(["approved", "rejected", "dismissed"])
const VERDICTS = new Set(["pass", "fail", "unsure"])

/** The part labels, read from a translator scoped to `export.document`. */
export function partLabelsFrom(t: PartLabelTranslator): PartLabels {
  return {
    thinking: t("parts.thinking"),
    tool: (name) => t("parts.tool", { name }),
    toolInput: t("parts.toolInput"),
    toolOutput: t("parts.toolOutput"),
    toolError: t("parts.toolError"),
    file: t("parts.file"),
    source: t("parts.source"),
    sources: t("parts.sources"),
    privateSources: (count) => t("parts.privateSources", { count }),
    artifact: (title, kind) => t("parts.artifact", { title, kind }),
    canvas: (title) => t("parts.canvas", { title }),
    subagent: (name, status) => t("parts.subagent", { name, status }),
    interactiveSurface: t("parts.interactiveSurface"),
    notExported: (type) => t("parts.notExported", { type }),
    toolSummary: t("parts.toolSummary"),
    teamDispatch: (name) => t("parts.teamDispatch", { name }),
    squadRun: (name) => t("parts.squadRun", { name }),
    squadGate: (title, decision) =>
      t("parts.squadGate", {
        title,
        decision: GATE_DECISIONS.has(decision) ? t(`parts.gateDecision.${decision}`) : decision,
      }),
    verification: (verdict) =>
      t("parts.verification", {
        verdict: VERDICTS.has(verdict) ? t(`parts.verdict.${verdict}`) : verdict,
      }),
    verificationRunning: t("parts.verificationRunning"),
    verificationFailed: (error) => t("parts.verificationFailed", { error }),
    grounding: (supported, total) => t("parts.grounding", { supported, total }),
    withheld: t("parts.withheld"),
    compacted: t("parts.compacted"),
  }
}
