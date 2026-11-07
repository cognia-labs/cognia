/**
 * The `automation` module's tool family (ADR-0250 §14 amendment), for managed
 * desktop acceptance (ADR-0233 A6): evidence-only tools for the child session
 * a human-started acceptance run was attached to, and a separate proposal
 * with no spend authority for every other desktop chat. Both talk to the
 * local Host, so both need the desktop.
 */
import type { ChatSession } from "@cognia/agent-config-types"
import { getSession } from "@/lib/db/sessions"
import type {
  ModuleToolEntry,
  ModuleToolFamily,
  ToolSurfaceContext,
} from "@/lib/modules/manifest-types"
import { managedDesktopClient } from "./managed-desktop-client"
import {
  managedDesktopHandoffClient,
  validManagedDesktopCriteria,
  type ManagedDesktopAcceptanceCriterion,
  type ManagedDesktopAcceptanceComplete,
  type ManagedDesktopDeliverySummary,
} from "./managed-desktop-handoff-client"
import { createManagedDesktopResultsScope } from "./managed-desktop-results-client"

type AcceptanceSession = ChatSession & { managedAcceptance?: { acceptanceId: string } }
const PREFIX = "mcp__cognia-plugin-tools__"
/** The evidence tools of an acceptance child session. */
export const ACCEPTANCE_TOOL_NAMES = ["acceptance_checkpoint", "acceptance_complete"] as const
const TOOLS = ACCEPTANCE_TOOL_NAMES
export const PROPOSE_ACCEPTANCE_TOOL_NAME = "propose_acceptance"
const normalize = (name: string) => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name)
const outcomes = ["passed", "failed", "inconclusive", "cancelled"] as const
const criterionOutcomes = ["passed", "failed", "incomplete"] as const
const criterionId = { type: "string", pattern: "^criterion-[0-9]+$" }
const criteriaSchema = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["description", "screenshotRequired"],
    properties: {
      description: { type: "string", minLength: 1, maxLength: 1024 },
      screenshotRequired: { type: "boolean" },
    },
  },
}

export function buildAcceptanceManifestEntries(): ModuleToolEntry[] {
  return [
    {
      name: TOOLS[0],
      description:
        "Save a private checkpoint screenshot for criterion-0, criterion-1, etc. in this human-started acceptance. Stored evidence is not sent to a model. Retries reuse the criterion's checkpoint.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId"],
        properties: { criterionId },
      },
    },
    {
      name: TOOLS[1],
      description:
        "Complete this acceptance with an agent verdict. All criteria and required screenshots must be complete to pass. This destroys its desktop; it never approves, merges or completes the source task.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["outcome", "criteria", "summary"],
        properties: {
          outcome: { type: "string", enum: [...outcomes] },
          summary: { type: "string", maxLength: 8192 },
          criteria: {
            type: "array",
            maxItems: 50,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["criterionId", "outcome"],
              properties: {
                criterionId,
                outcome: { type: "string", enum: [...criterionOutcomes] },
                note: { type: "string", maxLength: 1024 },
                artifactIds: { type: "array", maxItems: 100, items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  ]
}
export function isAcceptanceBuiltinTool(name: string): boolean {
  return TOOLS.some((tool) => normalize(name) === tool)
}

function object(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
}
const bytes = (value: string) => new TextEncoder().encode(value).length
const invalid = () => ({ ok: false as const, code: "invalid_arguments" })

export async function runAcceptanceBuiltinTool(
  name: string,
  input: unknown,
  { sessionId }: { sessionId: string }
) {
  try {
    if (!isAcceptanceBuiltinTool(name) || !object(input)) return invalid()
    const session = (await getSession(sessionId)) as AcceptanceSession | undefined
    const acceptanceId = session?.managedAcceptance?.acceptanceId
    if (!acceptanceId) return { ok: false as const, code: "acceptance_session_required" }
    const binding = { acceptanceId, sessionKey: sessionId }
    if (normalize(name) === TOOLS[0]) {
      if (
        Object.keys(input).some((key) => key !== "criterionId") ||
        typeof input.criterionId !== "string" ||
        !/^criterion-\d+$/.test(input.criterionId)
      )
        return invalid()
      const artifact = await managedDesktopHandoffClient.acceptanceCheckpoint({
        ...binding,
        criterionId: input.criterionId,
        idempotencyKey: `checkpoint:${input.criterionId}`,
      })
      return { ok: true as const, code: "recorded", artifactId: artifact.id }
    }
    if (
      Object.keys(input).some((key) => !["outcome", "criteria", "summary"].includes(key)) ||
      !outcomes.includes(input.outcome as (typeof outcomes)[number]) ||
      typeof input.summary !== "string" ||
      !Array.isArray(input.criteria) ||
      input.criteria.length > 50
    )
      return invalid()
    const ids = new Set<string>()
    for (const row of input.criteria) {
      if (
        !object(row) ||
        Object.keys(row).some(
          (key) => !["criterionId", "outcome", "note", "artifactIds"].includes(key)
        ) ||
        typeof row.criterionId !== "string" ||
        !/^criterion-\d+$/.test(row.criterionId) ||
        ids.has(row.criterionId) ||
        !criterionOutcomes.includes(row.outcome as (typeof criterionOutcomes)[number]) ||
        (row.note !== undefined && (typeof row.note !== "string" || bytes(row.note) > 1024)) ||
        (row.artifactIds !== undefined &&
          (!Array.isArray(row.artifactIds) ||
            row.artifactIds.length > 100 ||
            !row.artifactIds.every((id) => typeof id === "string")))
      )
        return invalid()
      ids.add(row.criterionId)
    }
    const rows = input.criteria as Array<{
      criterionId: string
      outcome: (typeof criterionOutcomes)[number]
      note?: string
      artifactIds?: string[]
    }>
    // The wire contract has no per-criterion note. Preserve notes in the summary.
    const summary = [
      input.summary,
      ...rows.filter((row) => row.note).map((row) => `${row.criterionId}: ${row.note}`),
    ].join("\n")
    if (bytes(summary) > 8192) return invalid()
    const scope = createManagedDesktopResultsScope()
    try {
      // Read metadata only: screenshot pixels never enter the model's tool result.
      const result = await scope.get(acceptanceId)
      const request: ManagedDesktopAcceptanceComplete = {
        ...binding,
        idempotencyKey: `complete:${acceptanceId}`,
        outcome: input.outcome as (typeof outcomes)[number],
        summary,
        criteria: rows.map((row) => ({
          criterionId: row.criterionId,
          outcome: row.outcome,
          artifactIds:
            row.artifactIds ??
            result.artifacts
              .filter((artifact) => artifact.criterionId === row.criterionId)
              .map((artifact) => artifact.id),
        })),
      }
      scope.assertActive()
      await managedDesktopHandoffClient.acceptanceComplete(request)
      return { ok: true as const, code: "recorded" }
    } finally {
      scope.dispose()
    }
  } catch {
    // Do not leak provider text, credential-bearing errors or paths into a turn.
    return { ok: false as const, code: "acceptance_tool_failed" }
  }
}

export interface AcceptanceProposal {
  delivery: ManagedDesktopDeliverySummary
  criteria: ManagedDesktopAcceptanceCriterion[]
  summary?: string
  estimate: { currency: string; hourlyRateMicros: number } | null
}
export function buildAcceptanceProposalManifestEntries(): ModuleToolEntry[] {
  return [
    {
      name: PROPOSE_ACCEPTANCE_TOOL_NAME,
      description:
        "Suggest GUI acceptance of an immutable delivery. Returns a proposal card only. No prepare, authorization, template build, start or spending occurs; the human opens the panel and confirms a fresh quote.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["criteria"],
        properties: {
          deliveryId: { type: "string", minLength: 1 },
          criteria: criteriaSchema,
          summary: { type: "string", maxLength: 8192 },
        },
      },
    },
  ]
}
export function isAcceptanceProposalTool(name: string): boolean {
  return normalize(name) === PROPOSE_ACCEPTANCE_TOOL_NAME
}
export async function runAcceptanceProposalTool(
  input: unknown,
  { sessionId }: { sessionId: string }
) {
  try {
    if (
      !object(input) ||
      Object.keys(input).some((key) => !["deliveryId", "criteria", "summary"].includes(key)) ||
      !validManagedDesktopCriteria(input.criteria) ||
      (input.deliveryId !== undefined &&
        (typeof input.deliveryId !== "string" || !input.deliveryId.trim())) ||
      (input.summary !== undefined &&
        (typeof input.summary !== "string" || bytes(input.summary) > 8192))
    )
      return invalid()
    const session = (await getSession(sessionId)) as AcceptanceSession | undefined
    if (!session || session.managedAcceptance)
      return { ok: false as const, code: "acceptance_source_session_required" }
    const [deliveries, configs] = await Promise.all([
      managedDesktopHandoffClient.deliveries({ kind: "local" }),
      managedDesktopClient.listConfigs({ kind: "local" }),
    ])
    const delivery = input.deliveryId
      ? deliveries.find((row) => row.id === input.deliveryId)
      : [...deliveries].sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!delivery) return { ok: false as const, code: "acceptance_delivery_unavailable" }
    const config = configs.find((row) => row.enabled && row.price.expiresAt > Date.now())
    return {
      ok: true as const,
      proposal: {
        delivery,
        criteria: input.criteria.map((row) => ({
          description: row.description,
          screenshotRequired: row.screenshotRequired,
        })),
        ...(typeof input.summary === "string" ? { summary: input.summary } : {}),
        estimate: config
          ? { currency: config.price.currency, hourlyRateMicros: config.price.hourlyRateMicros }
          : null,
      } satisfies AcceptanceProposal,
    }
  } catch {
    return { ok: false as const, code: "acceptance_proposal_failed" }
  }
}

/**
 * The family the kernel loads, on the desktop only. A child session an
 * acceptance run was attached to is offered the evidence tools; any other
 * chat with a screen on the other end (not an IM-bound session) is offered
 * the proposal, which reads deliveries and a price and cannot spend.
 */
export const toolFamily: ModuleToolFamily = {
  surface(ctx: ToolSurfaceContext) {
    if (ctx.host !== "desktop") return null
    const session = ctx.session as AcceptanceSession | null
    if (session?.managedAcceptance?.acceptanceId) return { tools: buildAcceptanceManifestEntries() }
    if (session?.managedAcceptance || session?.platformBinding?.adapterId) return null
    return { tools: buildAcceptanceProposalManifestEntries() }
  },
  async run(name, args, call) {
    return name === PROPOSE_ACCEPTANCE_TOOL_NAME
      ? runAcceptanceProposalTool(args, { sessionId: call.sessionId })
      : runAcceptanceBuiltinTool(name, args, { sessionId: call.sessionId })
  },
}
