/**
 * Portable prompt profiles (ADR-0236): export the published overrides of
 * code-owned prompt slots, and import them with a preview.
 *
 * A profile carries static template text only, never rendered prompts, and
 * names targets by their local ids. Ids are meaningless on another install, so
 * an import never trusts them: account-scoped entries apply directly, and an
 * entry for a workspace, agent or session applies only to a target the user
 * maps it to. Every entry is re-validated against the definition this build
 * ships, so text written for another contract, or failing the PII gate, is
 * reported instead of activated.
 */

import { z } from "zod"
import * as dbSchema from "@/lib/db/schema"
import {
  isPromptOverrideConflict,
  PromptOverrideAccountChangedError,
  readActivePromptOverrides,
} from "@/lib/db/prompt-overrides"
import { getPromptDefinition, loadPromptCatalog } from "./catalog"
import {
  publishPromptBody,
  publishPromptBodyBatch,
  readPromptSlot,
  shippedBodyDigest,
} from "./service"
import { validatePromptBody, type PromptValidationIssue } from "./template"
import type { PromptScope, PromptTargetRef } from "./types"

function currentDatabaseName(): string | undefined {
  try {
    if (typeof dbSchema.activeDatabaseName === "function") return dbSchema.activeDatabaseName()
    return dbSchema.getDb?.()?.name
  } catch {
    return undefined
  }
}

export const PROMPT_PROFILE_KIND = "cognia.prompt-profile" as const
export const PROMPT_PROFILE_SCHEMA_VERSION = 1 as const

const scopeSchema = z.enum(["account", "workspace", "agent", "session"])

const entrySchema = z.object({
  promptId: z.string().min(1).max(200),
  scope: scopeSchema,
  targetId: z.string().max(200),
  contractVersion: z.number().int().positive(),
  /** Digest of the shipped body the text was written against. */
  baseDigest: z.string().max(200),
  body: z.string().max(200_000),
})

const profileSchema = z.object({
  kind: z.literal(PROMPT_PROFILE_KIND),
  schemaVersion: z.literal(PROMPT_PROFILE_SCHEMA_VERSION),
  exportedAt: z.string(),
  entries: z.array(entrySchema).max(2_000),
})

export type PromptProfileEntryV1 = z.infer<typeof entrySchema>
export type PromptProfileV1 = z.infer<typeof profileSchema>

export class PromptProfileFormatError extends Error {
  readonly code = "prompt_profile_invalid"
  constructor(message: string) {
    super(message)
    this.name = "PromptProfileFormatError"
  }
}

/** Parse a profile file's text. Throws {@link PromptProfileFormatError} on anything malformed. */
export function parsePromptProfile(text: string): PromptProfileV1 {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PromptProfileFormatError("not JSON")
  }
  const parsed = profileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new PromptProfileFormatError(
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`)
        .join("; ")
    )
  }
  return parsed.data
}

export interface ExportPromptProfileOptions {
  /** Only these scopes; every scope when omitted. */
  scopes?: readonly PromptScope[]
  now?: () => Date
}

/** Every published override in the active account, as a portable profile. */
export async function exportPromptProfile(
  options: ExportPromptProfileOptions = {}
): Promise<PromptProfileV1> {
  const { entries: activeRows } = await readActivePromptOverrides()
  const entries: PromptProfileEntryV1[] = []
  activeRows.forEach(({ binding, revision }) => {
    if (options.scopes && !options.scopes.includes(binding.scope)) return
    if (!revision || revision.kind !== "published") return
    entries.push({
      promptId: binding.promptId,
      scope: binding.scope,
      targetId: binding.targetId,
      contractVersion: revision.contractVersion,
      baseDigest: revision.baseDigest,
      body: revision.body,
    })
  })
  entries.sort(
    (a, b) =>
      a.promptId.localeCompare(b.promptId) ||
      a.scope.localeCompare(b.scope) ||
      a.targetId.localeCompare(b.targetId)
  )
  return {
    kind: PROMPT_PROFILE_KIND,
    schemaVersion: PROMPT_PROFILE_SCHEMA_VERSION,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    entries,
  }
}

export type PromptImportStatus =
  /** Applies as a new override. */
  | "new"
  /**
   * Replaces what the slot publishes: different text, or the same text under
   * an older contract (which the resolver skips, so it publishes nothing now).
   */
  | "replace"
  /** The slot already publishes this exact text under the current contract. */
  | "unchanged"
  /** This build has no such prompt. */
  | "unknown-prompt"
  /** Written for another contract version of the prompt. */
  | "contract-mismatch"
  /** The prompt cannot be overridden at this scope. */
  | "scope-unsupported"
  /** A workspace / agent / session entry the user has not mapped to a local target. */
  | "needs-target"
  /** Fails the definition's validation (placeholders, fragments, length, PII). */
  | "invalid"

export interface PromptImportPreviewEntry {
  index: number
  entry: PromptProfileEntryV1
  status: PromptImportStatus
  /** The local slot the entry applies to, when it applies at all. */
  target?: PromptTargetRef
  /**
   * The slot's binding revision this status was judged against, and the
   * account database it was read from. Apply publishes against exactly these,
   * so anything written to the slot after the preview makes it a conflict.
   */
  baseRev?: number
  database?: string
  /** The shipped default changed since the text was written; the user should review it. */
  upstreamChanged: boolean
  issues: PromptValidationIssue[]
}

/** Local target id for each `scope:targetId` an entry names. */
export type PromptImportTargetMap = Readonly<Record<string, string>>

export function importTargetKey(entry: Pick<PromptProfileEntryV1, "scope" | "targetId">): string {
  return `${entry.scope}:${entry.targetId}`
}

function applicable(status: PromptImportStatus): boolean {
  return status === "new" || status === "replace"
}

/** What importing `profile` would do, slot by slot. Reads only. */
export async function previewPromptProfileImport(
  profile: PromptProfileV1,
  targetMap: PromptImportTargetMap = {}
): Promise<PromptImportPreviewEntry[]> {
  const expectedDatabase = currentDatabaseName()
  await loadPromptCatalog()
  const preview: PromptImportPreviewEntry[] = []
  for (const [index, entry] of profile.entries.entries()) {
    if (expectedDatabase !== undefined && currentDatabaseName() !== expectedDatabase) {
      throw new PromptOverrideAccountChangedError(
        expectedDatabase,
        currentDatabaseName() ?? "unknown"
      )
    }
    const def = getPromptDefinition(entry.promptId)
    const base = { index, entry, upstreamChanged: false, issues: [] as PromptValidationIssue[] }
    if (!def) {
      preview.push({ ...base, status: "unknown-prompt" })
      continue
    }
    if (def.operation === "inspect-only" || !def.scopes.includes(entry.scope)) {
      preview.push({ ...base, status: "scope-unsupported" })
      continue
    }
    if (entry.contractVersion !== def.contractVersion) {
      preview.push({ ...base, status: "contract-mismatch" })
      continue
    }
    const target = mapTarget(entry, targetMap)
    if (!target) {
      preview.push({ ...base, status: "needs-target" })
      continue
    }
    const upstreamChanged = entry.baseDigest !== (await shippedBodyDigest(def))
    const issues = validatePromptBody(def, entry.body)
    if (issues.length > 0) {
      preview.push({ ...base, status: "invalid", target, upstreamChanged, issues })
      continue
    }
    const slot = await readPromptSlot(def.id, target)
    if (expectedDatabase !== undefined && slot.database !== expectedDatabase) {
      throw new PromptOverrideAccountChangedError(expectedDatabase, slot.database)
    }
    const status: PromptImportStatus = !slot.active
      ? "new"
      : slot.active.kind === "published" &&
          slot.active.body === entry.body &&
          slot.active.contractVersion === def.contractVersion
        ? "unchanged"
        : "replace"
    preview.push({
      ...base,
      status,
      target,
      upstreamChanged,
      baseRev: slot.binding?.rev ?? 0,
      database: slot.database,
    })
  }
  if (expectedDatabase !== undefined && currentDatabaseName() !== expectedDatabase) {
    throw new PromptOverrideAccountChangedError(
      expectedDatabase,
      currentDatabaseName() ?? "unknown"
    )
  }
  return preview
}

function mapTarget(
  entry: PromptProfileEntryV1,
  targetMap: PromptImportTargetMap
): PromptTargetRef | undefined {
  if (entry.scope === "account") return { scope: "account", targetId: "" }
  const mapped = targetMap[importTargetKey(entry)]
  return mapped ? { scope: entry.scope, targetId: mapped } : undefined
}

export interface PromptImportResult {
  applied: number
  /** Entries that changed between preview and apply (a concurrent edit); left untouched. */
  conflicted: PromptImportPreviewEntry[]
}

/**
 * Publish the previewed entries the user selected. Each entry publishes on its
 * own (origin `import`) against the binding revision and account database its
 * preview read, so a slot written since the preview (by anyone, to anything)
 * is reported as a conflict for the user to review again instead of being
 * overwritten, and an account switch since the preview refuses the import.
 */
export async function applyPromptProfileImport(
  preview: readonly PromptImportPreviewEntry[],
  selected: ReadonlySet<number>
): Promise<PromptImportResult> {
  await loadPromptCatalog()
  const conflicted: PromptImportPreviewEntry[] = []
  const candidates: Array<{
    item: PromptImportPreviewEntry
    def: NonNullable<ReturnType<typeof getPromptDefinition>>
  }> = []
  let expectedDatabase: string | undefined

  for (const item of preview) {
    if (!selected.has(item.index) || !applicable(item.status) || !item.target) continue
    if (item.baseRev === undefined || item.database === undefined) {
      throw new Error(
        `import preview entry ${item.index} carries no slot revision to apply against`
      )
    }
    if (expectedDatabase === undefined) {
      expectedDatabase = item.database
    } else if (item.database !== expectedDatabase) {
      throw new PromptOverrideAccountChangedError(expectedDatabase, item.database)
    }
    const def = getPromptDefinition(item.entry.promptId)
    if (!def) {
      conflicted.push(item)
      continue
    }
    candidates.push({ item, def })
  }

  if (candidates.length === 0) return { applied: 0, conflicted }

  if (typeof publishPromptBodyBatch === "function") {
    const batch = await publishPromptBodyBatch(
      candidates.map(({ item, def }) => ({
        def,
        target: item.target!,
        body: item.entry.body,
        expectedRev: item.baseRev!,
        origin: "import" as const,
        database: item.database,
      })),
      { database: expectedDatabase }
    )
    for (const conflictedIndex of batch.conflictedIndices) {
      const match = candidates[conflictedIndex]
      if (match) conflicted.push(match.item)
    }
    return { applied: batch.applied, conflicted }
  }

  // Fallback only when a custom test stub wraps `publishPromptBody` without batching.
  let applied = 0
  for (const { item, def } of candidates) {
    try {
      await publishPromptBody({
        def,
        target: item.target!,
        body: item.entry.body,
        expectedRev: item.baseRev!,
        origin: "import",
        database: item.database,
      })
    } catch (error) {
      if (!isPromptOverrideConflict(error)) throw error
      conflicted.push(item)
      continue
    }
    applied += 1
  }
  return { applied, conflicted }
}

/** Serialize a profile for a download, with a stable layout for diffing. */
export function serializePromptProfile(profile: PromptProfileV1): string {
  return `${JSON.stringify(profile, null, 2)}\n`
}
