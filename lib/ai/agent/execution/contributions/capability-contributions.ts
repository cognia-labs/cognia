/**
 * Grants that feature modules contribute to every run (ADR-0198 amendment,
 * ADR-0250 §14 M3).
 *
 * A module names a `capabilityContributions` file in its manifest; the
 * generated registry `lib/modules/generated/capabilities.ts` lists those files
 * lazily, so the resolver imports no module. `resolveSendOptions` folds what
 * they produce together with the caller's grants, at the point it already
 * folds `capabilityGrants`: a new grant source, not a new resolution stage.
 *
 * Every contribution runs on every resolution, concurrently, under one
 * deadline. What a failure means is the contribution's own declaration:
 * `"skip"` leaves it out and reports it, `"refuse-turn"` fails the
 * resolution. A `"skip"` contribution that tries to narrow (deny, restrict,
 * remove, cap) is refused, because losing it silently would widen a run. A
 * contribution file that does not load fails the resolution too: it might
 * hold a narrowing contribution, and which ones it holds is unknown until it
 * loads. A load is retried on the next resolution.
 */

import { loggers } from "@cognia/logging"
import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import { MODULE_CAPABILITY_CONTRIBUTIONS } from "@/lib/modules/generated/capabilities"
import type {
  CapabilityContribution,
  CapabilityContributionContext,
  ContributedCapabilityGrant,
  ModuleCapabilityContributionsEntry,
} from "@/lib/modules/manifest-types"

/** How long all contributions together may take on one resolution. */
export const CAPABILITY_CONTRIBUTION_DEADLINE_MS = 2_000

/** The caller's own choices for its run; a contribution may not set them. */
const FORBIDDEN_FIELDS = ["model", "provider", "effort", "maxTurns", "permissionProfile"] as const

/** A contribution left out of a run, and why. */
export interface SkippedCapabilityContribution {
  id: string
  error: unknown
}

/** Thrown when a `"refuse-turn"` contribution, or a contribution file, fails. */
export class CapabilityContributionError extends Error {
  constructor(
    readonly contributionId: string,
    readonly reason: unknown
  ) {
    super(
      `capability contribution "${contributionId}" failed: ${
        reason instanceof Error ? reason.message : String(reason)
      }`
    )
    this.name = "CapabilityContributionError"
  }
}

interface LoadedContribution {
  /** `<module>/<id>`, the grant's source id. */
  id: string
  contribution: CapabilityContribution
}

const loaded = new Map<string, readonly LoadedContribution[]>()
const loading = new Map<string, Promise<readonly LoadedContribution[]>>()

function checkShape(module: string, list: unknown): readonly LoadedContribution[] {
  if (!Array.isArray(list)) throw new Error(`${module}: \`contributions\` is not a list`)
  const ids = new Set<string>()
  return list.map((item: CapabilityContribution) => {
    if (!item || typeof item.id !== "string" || item.id.length === 0)
      throw new Error(`${module}: a contribution has no id`)
    if (ids.has(item.id)) throw new Error(`${module}: contribution "${item.id}" is listed twice`)
    ids.add(item.id)
    if (item.failure !== "skip" && item.failure !== "refuse-turn")
      throw new Error(`${module}/${item.id}: failure is "skip" or "refuse-turn"`)
    if (typeof item.produce !== "function")
      throw new Error(`${module}/${item.id}: produce is not a function`)
    return { id: `${module}/${item.id}`, contribution: item }
  })
}

function loadModule(
  entry: ModuleCapabilityContributionsEntry
): Promise<readonly LoadedContribution[]> {
  const known = loaded.get(entry.module)
  if (known) return Promise.resolve(known)
  let pending = loading.get(entry.module)
  if (!pending) {
    pending = entry
      .load()
      .then(({ contributions }) => {
        const list = checkShape(entry.module, contributions)
        loaded.set(entry.module, list)
        return list
      })
      .finally(() => loading.delete(entry.module))
    loading.set(entry.module, pending)
  }
  return pending
}

/** The fields of a grant that narrow a run; a `"skip"` contribution may set none. */
function narrowingFields(grant: ContributedCapabilityGrant): string[] {
  const found: string[] = []
  if (grant.tools?.deny !== undefined) found.push("tools.deny")
  if (grant.tools?.restrictTo !== undefined) found.push("tools.restrictTo")
  if (grant.skills?.remove !== undefined) found.push("skills.remove")
  if (grant.mcpServers?.remove !== undefined) found.push("mcpServers.remove")
  if (grant.mcpServers?.only !== undefined) found.push("mcpServers.only")
  if (grant.subagents?.only !== undefined) found.push("subagents.only")
  if (grant.permissionMode !== undefined) found.push("permissionMode")
  if (grant.maxBudgetUsd !== undefined) found.push("maxBudgetUsd")
  return found
}

/** The stamped grant, or the reason it is refused. */
function stamp(
  id: string,
  contribution: CapabilityContribution,
  grant: ContributedCapabilityGrant
): AgentCapabilityGrantV1 {
  const record = grant as Record<string, unknown>
  const forbidden = FORBIDDEN_FIELDS.filter((field) => record[field] !== undefined)
  if (forbidden.length)
    throw new Error(`a contribution may not set ${forbidden.join(", ")}: they are the caller's`)
  if (contribution.failure === "skip") {
    const narrowing = narrowingFields(grant)
    if (narrowing.length)
      throw new Error(`a "skip" contribution may only add; it sets ${narrowing.join(", ")}`)
  }
  const { schemaVersion: _version, source: _source, ...fields } = record
  return {
    ...(fields as ContributedCapabilityGrant),
    schemaVersion: 1,
    source: { kind: "module", id },
  }
}

function withDeadline<T>(work: Promise<T>, deadline: Promise<never>): Promise<T> {
  return Promise.race([work, deadline])
}

/**
 * The grants every active module contributes to this run, in module id order
 * and then manifest order. Throws {@link CapabilityContributionError} when a
 * `"refuse-turn"` contribution or a contribution file fails.
 */
export async function collectContributedGrants(
  ctx: CapabilityContributionContext,
  entries: readonly ModuleCapabilityContributionsEntry[] = MODULE_CAPABILITY_CONTRIBUTIONS,
  deadlineMs: number = CAPABILITY_CONTRIBUTION_DEADLINE_MS
): Promise<{ grants: AgentCapabilityGrantV1[]; skipped: SkippedCapabilityContribution[] }> {
  const active = entries.filter((entry) => entry.stage !== "experimental")
  if (active.length === 0) return { grants: [], skipped: [] }

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${deadlineMs} ms`)), deadlineMs)
  })
  // A contribution still running when another one refuses the turn must not
  // surface as an unhandled rejection.
  deadline.catch(() => undefined)
  try {
    const modules = await Promise.allSettled(active.map((entry) => loadModule(entry)))
    const contributions: LoadedContribution[] = []
    modules.forEach((outcome, index) => {
      if (outcome.status === "rejected")
        throw new CapabilityContributionError(active[index].module, outcome.reason)
      contributions.push(...outcome.value)
    })
    const produced = await Promise.allSettled(
      contributions.map(({ id, contribution }) =>
        withDeadline(
          Promise.resolve().then(() => contribution.produce(ctx)),
          deadline
        ).then((grant) => (grant ? stamp(id, contribution, grant) : null))
      )
    )
    const grants: AgentCapabilityGrantV1[] = []
    const skipped: SkippedCapabilityContribution[] = []
    produced.forEach((outcome, index) => {
      const { id, contribution } = contributions[index]
      if (outcome.status === "fulfilled") {
        if (outcome.value) grants.push(outcome.value)
        return
      }
      if (contribution.failure === "refuse-turn")
        throw new CapabilityContributionError(id, outcome.reason)
      loggers.agent.warn("capability contribution skipped", {
        contribution: id,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      })
      skipped.push({ id, error: outcome.reason })
    })
    return { grants, skipped }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Test helper: forget every loaded contribution file. */
export function __resetCapabilityContributionsForTests(): void {
  loaded.clear()
  loading.clear()
}
