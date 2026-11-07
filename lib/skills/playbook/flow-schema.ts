/**
 * The structured step list a playbook skill may carry (ADR-0254 §1).
 *
 * A playbook is a skill composed of other skills. Its `SKILL.md` stays a
 * standard skill; the steps live beside it at `references/flow.yaml`, the one
 * path that survives built-in packaging, the disk mirror and the native scan
 * unchanged. This file is the shape of that document, version 1. Parsing,
 * the cross-field rules and problem reporting are in `parse-flow.ts`; the
 * compiler that lowers a flow to a `VisualWorkflow` reads the parsed form.
 *
 * Every object is strict: an unknown key is a problem, not something ignored,
 * so a misspelt `requiresTool` cannot silently drop a requirement.
 */

import { z } from "zod"

import { ULTRACODE_PATTERN_KINDS, type UltracodePatternKind } from "@/types/agent/ultracode"

/** Where a playbook keeps its steps inside the skill directory. */
export const PLAYBOOK_FLOW_PATH = "references/flow.yaml"

/** The only `version` this parser reads. */
export const PLAYBOOK_FLOW_VERSION = 1

export const PLAYBOOK_FLOW_LIMITS = {
  /**
   * UTF-8 bytes of `flow.yaml`. Matches one `load_skill_resource` page, so an
   * agent running the playbook as a skill can always read the whole file.
   */
  maxBytes: 64 * 1024,
  maxSteps: 64,
  maxInputs: 32,
  /** Ceiling for `limits.maxSubagents` / `limits.maxFanout`. Guards typos, not policy. */
  maxCount: 256,
} as const

/** `action.issue.*` operations a step may use. */
export const PLAYBOOK_ISSUE_OPERATIONS = [
  "create",
  "get",
  "list",
  "update",
  "assign",
  "comment",
  "label",
] as const
export type PlaybookIssueOperation = (typeof PLAYBOOK_ISSUE_OPERATIONS)[number]

/** What a step runs, decoded from its `uses` string. */
export type PlaybookStepUse =
  | { kind: "skill"; skillId: string }
  | { kind: "pattern"; pattern: UltracodePatternKind }
  | { kind: "squad"; templateId: string }
  | { kind: "playbook"; skillId: string }
  | { kind: "approval" }
  | { kind: "issue"; operation: PlaybookIssueOperation }
  | { kind: "notify" }

/** Step ids name graph nodes and appear in `{{steps.<id>…}}` references. */
export const PLAYBOOK_STEP_ID = /^[a-z][a-z0-9-]{0,62}$/

/** Input names appear as `{{inputs.<name>}}`. */
export const PLAYBOOK_INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * Decode a `uses` string. Returns `null` when the string names nothing this
 * version knows; the parser turns that into a problem at the step's pointer.
 */
export function decodeStepUse(uses: string): PlaybookStepUse | null {
  if (uses === "approval") return { kind: "approval" }
  if (uses === "notify") return { kind: "notify" }
  if (uses.startsWith("issue.")) {
    const operation = uses.slice("issue.".length)
    return (PLAYBOOK_ISSUE_OPERATIONS as readonly string[]).includes(operation)
      ? { kind: "issue", operation: operation as PlaybookIssueOperation }
      : null
  }
  const colon = uses.indexOf(":")
  if (colon <= 0) return null
  const prefix = uses.slice(0, colon)
  const target = uses.slice(colon + 1)
  if (!target || /\s/.test(target)) return null
  switch (prefix) {
    case "skill":
      return { kind: "skill", skillId: target }
    case "playbook":
      return { kind: "playbook", skillId: target }
    case "squad":
      return { kind: "squad", templateId: target }
    case "pattern":
      return (ULTRACODE_PATTERN_KINDS as readonly string[]).includes(target)
        ? { kind: "pattern", pattern: target as UltracodePatternKind }
        : null
    default:
      return null
  }
}

const positiveCount = z.int().min(1).max(PLAYBOOK_FLOW_LIMITS.maxCount)

export const playbookInputSchema = z.strictObject({
  name: z.string().regex(PLAYBOOK_INPUT_NAME),
  /** Same meaning as the skill recorder's input variables. */
  kind: z.enum(["variable", "literal", "sensitive"]).default("variable"),
  description: z.string().optional(),
  required: z.boolean().default(true),
  /** Not allowed on a `sensitive` input; checked in `parse-flow.ts`. */
  default: z.string().optional(),
})

export const playbookStepSchema = z.strictObject({
  id: z.string().regex(PLAYBOOK_STEP_ID),
  /** `skill:<id>`, `pattern:<kind>`, `squad:<templateId>`, `playbook:<skillId>`, `approval`, `issue.<op>`, `notify`. */
  uses: z.string().min(1),
  /** Step parameters. String values may hold `{{inputs.x}}` / `{{steps.<id>.output…}}` references. */
  with: z.record(z.string(), z.unknown()).default({}),
  /** Steps that must finish first. A reference to another step's output must name an ancestor. */
  needs: z.array(z.string()).default([]),
  /** A reference to an array; the step runs once per item, as `{{item}}`. */
  forEach: z.string().optional(),
  /** The step needs repository tools (Bash, Read, Edit). A tool-less runner refuses it. */
  requiresTools: z.boolean().default(false),
  /** A person confirms before the step runs. */
  humanConfirm: z.boolean().default(false),
})

export const playbookLimitsSchema = z.strictObject({
  maxSubagents: positiveCount.optional(),
  maxFanout: positiveCount.optional(),
  maxBudgetUsd: z.number().positive().finite().optional(),
})

export const playbookFlowSchema = z.strictObject({
  version: z.literal(PLAYBOOK_FLOW_VERSION),
  inputs: z.array(playbookInputSchema).max(PLAYBOOK_FLOW_LIMITS.maxInputs).default([]),
  steps: z.array(playbookStepSchema).min(1).max(PLAYBOOK_FLOW_LIMITS.maxSteps),
  limits: playbookLimitsSchema.default({}),
  /** Named results. Values are references, usually to the last step's output. */
  outputs: z.record(z.string(), z.string()).default({}),
})

export type PlaybookInput = z.infer<typeof playbookInputSchema>
export type PlaybookLimits = z.infer<typeof playbookLimitsSchema>

/** A step after parsing: `uses` decoded, defaults applied. */
export interface PlaybookStep extends Omit<z.infer<typeof playbookStepSchema>, "uses"> {
  uses: string
  use: PlaybookStepUse
}

/** A parsed, validated flow. */
export interface PlaybookFlow {
  version: typeof PLAYBOOK_FLOW_VERSION
  inputs: PlaybookInput[]
  steps: PlaybookStep[]
  limits: PlaybookLimits
  outputs: Record<string, string>
}
