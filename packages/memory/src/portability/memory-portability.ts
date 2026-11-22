/**
 * Scoped memory portability: bundle export (JSON + Markdown) and reviewed
 * import preview with duplicate/conflict detection, PII gating, and conservative
 * trust/sensitivity quarantine (`G7`).
 *
 * Pure and dependency-injected so both `@cognia/memory` tests and the `/memory`
 * portability wizard run identical logic without touching Dexie during preview.
 */

import { classifySensitiveMemoryTopic } from "../control-plane/sensitive-topics"
import { meaningfulTerms } from "../retrieve/retriever"
import {
  isMemoryType,
  isProjectMemoryKind,
  type Memory,
  type MemoryProvenance,
  type MemoryReviewStatus,
  type MemoryScope,
  type MemorySensitivity,
  type MemoryTrustState,
  type MemoryType,
  type ProjectMemoryKind,
  type SensitiveMemoryCategory,
} from "../types/memory"

export const MEMORY_EXPORT_SCHEMA = "cognia-memory-export-v1" as const

export type MemoryExportFormat = "json" | "markdown"

export interface MemoryPortableItem {
  text: string
  type: MemoryType
  scope: MemoryScope
  importance: number
  key?: string
  tags: string[]
  projectId?: string
  characterId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  projectMemoryKind?: ProjectMemoryKind
  observedAt?: number
  sensitivity?: MemorySensitivity
  provenance?: MemoryProvenance
}

export interface MemoryExportBundleV1 {
  schema: typeof MEMORY_EXPORT_SCHEMA
  exportedAt: number
  count: number
  scopeSummary: Partial<Record<MemoryScope, number>>
  items: MemoryPortableItem[]
}

export interface ExportMemoriesBundleOptions {
  format?: MemoryExportFormat
  exportedAt?: number
  /** Include invalidated (archived) rows; false by default. */
  includeArchived?: boolean
  /** Optional scope filter applied before serialization. */
  scopes?: readonly MemoryScope[]
}

export type MemoryImportDisposition = "add" | "duplicate" | "conflict" | "blocked_pii"

export type MemoryImportTrustPosture =
  "unreviewed" | "pending_instruction" | "quarantined_sensitive"

export interface MemoryImportPreviewItem {
  index: number
  candidate: MemoryPortableItem
  disposition: MemoryImportDisposition
  existingId?: string
  existingText?: string
  trustPosture: MemoryImportTrustPosture
  sensitiveCategories: SensitiveMemoryCategory[]
  effectiveReviewStatus: MemoryReviewStatus
  effectiveTrustState: MemoryTrustState
  effectiveSensitivity: MemorySensitivity
}

export interface MemoryImportPreview {
  ok: boolean
  format: "json" | "markdown" | "invalid"
  error?: string
  items: MemoryImportPreviewItem[]
  counts: {
    total: number
    add: number
    duplicate: number
    conflict: number
    blockedPii: number
    pendingReview: number
    sensitive: number
  }
}

export interface PreviewMemoryImportOptions {
  /** Override every imported item's scope (e.g. force into current workspace). */
  overrideScope?: MemoryScope
  defaultProjectId?: string
  defaultCharacterId?: string
  defaultAgentId?: string
  /** PII safety predicate (e.g. `hasNoLeakingPii`). */
  isPiiSafe?: (text: string) => boolean
  /** Mirrors `MemoryConfig.allowSensitiveTopics` (default false). */
  allowSensitiveTopics?: boolean
}

const VALID_SCOPES: readonly MemoryScope[] = ["global", "workspace", "character", "agent"]

function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (VALID_SCOPES as readonly string[]).includes(value)
}

function clampImportance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 6
  return Math.min(10, Math.max(1, Math.round(value)))
}

function normalizeTextForComparison(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
}

function toPortableItem(memory: Memory): MemoryPortableItem {
  return {
    text: memory.text,
    type: memory.type,
    scope: memory.scope,
    importance: memory.importance,
    ...(memory.key ? { key: memory.key } : {}),
    tags: [...memory.tags],
    ...(memory.projectId ? { projectId: memory.projectId } : {}),
    ...(memory.characterId ? { characterId: memory.characterId } : {}),
    ...(memory.agentId ? { agentId: memory.agentId } : {}),
    ...(memory.branch ? { branch: memory.branch } : {}),
    ...(memory.pathPattern ? { pathPattern: memory.pathPattern } : {}),
    ...(memory.projectMemoryKind ? { projectMemoryKind: memory.projectMemoryKind } : {}),
    ...(memory.observedAt !== undefined ? { observedAt: memory.observedAt } : {}),
    ...(memory.sensitivity && memory.sensitivity !== "unknown"
      ? { sensitivity: memory.sensitivity }
      : {}),
    provenance: memory.provenance,
  }
}

export function exportMemoriesBundle(
  memories: readonly Memory[],
  options: ExportMemoriesBundleOptions = {}
): string {
  const format = options.format ?? "json"
  const exportedAt = options.exportedAt ?? Date.now()
  const scopeAllow = options.scopes && options.scopes.length > 0 ? new Set(options.scopes) : null

  const eligible = memories.filter((memory) => {
    if (memory.revisionOf !== undefined) return false
    if (!options.includeArchived && memory.status !== "active") return false
    if (scopeAllow && !scopeAllow.has(memory.scope)) return false
    return Boolean(memory.text.trim())
  })

  const items = eligible.map(toPortableItem)
  const scopeSummary: Partial<Record<MemoryScope, number>> = {}
  for (const item of items) {
    scopeSummary[item.scope] = (scopeSummary[item.scope] ?? 0) + 1
  }

  if (format === "json") {
    const bundle: MemoryExportBundleV1 = {
      schema: MEMORY_EXPORT_SCHEMA,
      exportedAt,
      count: items.length,
      scopeSummary,
      items,
    }
    return JSON.stringify(bundle, null, 2)
  }

  const lines: string[] = [
    "# Cognia Memory Export",
    `<!-- schema: ${MEMORY_EXPORT_SCHEMA}; exportedAt: ${new Date(exportedAt).toISOString()}; count: ${items.length} -->`,
    "",
  ]
  const grouped = new Map<string, { heading: string; rows: MemoryPortableItem[] }>()
  for (const item of items) {
    const groupKey =
      item.scope === "workspace"
        ? `workspace:${item.projectId ?? ""}`
        : item.scope === "character"
          ? `character:${item.characterId ?? ""}`
          : item.scope === "agent"
            ? `agent:${item.agentId ?? ""}`
            : "global"
    const heading =
      item.scope === "workspace"
        ? `## Workspace${item.projectId ? ` (${item.projectId})` : ""}`
        : item.scope === "character"
          ? `## Character${item.characterId ? ` (${item.characterId})` : ""}`
          : item.scope === "agent"
            ? `## Agent${item.agentId ? ` (${item.agentId})` : ""}`
            : "## Global"
    const bucket = grouped.get(groupKey) ?? { heading, rows: [] }
    bucket.rows.push(item)
    grouped.set(groupKey, bucket)
  }

  for (const { heading, rows } of grouped.values()) {
    lines.push(heading, "")
    for (const row of rows) {
      const metaParts = [`importance=${row.importance}`]
      if (row.key) metaParts.push(`key=${encodeURIComponent(row.key)}`)
      if (row.tags.length > 0) metaParts.push(`tags=${encodeURIComponent(row.tags.join(","))}`)
      if (row.projectMemoryKind) metaParts.push(`kind=${row.projectMemoryKind}`)
      if (row.branch) metaParts.push(`branch=${encodeURIComponent(row.branch)}`)
      if (row.pathPattern) metaParts.push(`path=${encodeURIComponent(row.pathPattern)}`)
      const singleLineText = row.text.replace(/\r?\n/g, " ").trim()
      lines.push(`- [${row.type}] ${singleLineText} <!-- ${metaParts.join("; ")} -->`)
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd() + "\n"
}

function parseJsonCandidates(raw: string): MemoryPortableItem[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { memories?: unknown }).memories)
        ? (parsed as { memories: unknown[] }).memories
        : null
  if (!list) return null

  const out: MemoryPortableItem[] = []
  for (const entry of list) {
    if (typeof entry === "string") {
      const text = entry.trim()
      if (text) {
        out.push({ text, type: "semantic", scope: "global", importance: 6, tags: [] })
      }
      continue
    }
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const text = typeof record.text === "string" ? record.text.trim() : ""
    if (!text) continue
    const type: MemoryType = isMemoryType(record.type) ? record.type : "semantic"
    const scope: MemoryScope = isMemoryScope(record.scope) ? record.scope : "global"
    const tags = Array.isArray(record.tags)
      ? record.tags
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : []
    out.push({
      text,
      type,
      scope,
      importance: clampImportance(record.importance),
      ...(typeof record.key === "string" && record.key.trim() ? { key: record.key.trim() } : {}),
      tags,
      ...(typeof record.projectId === "string" && record.projectId.trim()
        ? { projectId: record.projectId.trim() }
        : {}),
      ...(typeof record.characterId === "string" && record.characterId.trim()
        ? { characterId: record.characterId.trim() }
        : {}),
      ...(typeof record.agentId === "string" && record.agentId.trim()
        ? { agentId: record.agentId.trim() }
        : {}),
      ...(typeof record.branch === "string" && record.branch.trim()
        ? { branch: record.branch.trim() }
        : {}),
      ...(typeof record.pathPattern === "string" && record.pathPattern.trim()
        ? { pathPattern: record.pathPattern.trim() }
        : {}),
      ...(isProjectMemoryKind(record.projectMemoryKind)
        ? { projectMemoryKind: record.projectMemoryKind }
        : {}),
      ...(typeof record.observedAt === "number" && Number.isFinite(record.observedAt)
        ? { observedAt: record.observedAt }
        : {}),
    })
  }
  return out
}

function parseMarkdownCandidates(raw: string): MemoryPortableItem[] {
  const out: MemoryPortableItem[] = []
  let currentScope: MemoryScope = "global"
  let currentTargetId: string | undefined

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const headingMatch = /^##\s+(Global|Workspace|Character|Agent)(?:\s*\(([^)]+)\))?/i.exec(line)
    if (headingMatch) {
      const label = headingMatch[1]!.toLowerCase()
      currentScope =
        label === "workspace"
          ? "workspace"
          : label === "character"
            ? "character"
            : label === "agent"
              ? "agent"
              : "global"
      currentTargetId = headingMatch[2]?.trim() || undefined
      continue
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(line)
    if (!bulletMatch) continue

    let body = bulletMatch[1]!.trim()
    let importance = 6
    let key: string | undefined
    let tags: string[] = []
    let projectMemoryKind: ProjectMemoryKind | undefined
    let branch: string | undefined
    let pathPattern: string | undefined

    const commentMatch = /^(.*?)\s*<!--\s*(.*?)\s*-->$/.exec(body)
    if (commentMatch) {
      body = commentMatch[1]!.trim()
      for (const pair of commentMatch[2]!.split(";")) {
        const [rawK, rawV] = pair.split("=")
        const k = rawK?.trim()
        const v = rawV?.trim()
        if (!k || !v) continue
        if (k === "importance") importance = clampImportance(Number(v))
        else if (k === "key") key = decodeURIComponent(v)
        else if (k === "tags") {
          tags = decodeURIComponent(v)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        } else if (k === "kind" && isProjectMemoryKind(v)) projectMemoryKind = v
        else if (k === "branch") branch = decodeURIComponent(v)
        else if (k === "path") pathPattern = decodeURIComponent(v)
      }
    }

    let type: MemoryType = "semantic"
    const typeMatch = /^\[(semantic|episodic|procedural)\]\s+(.+)$/i.exec(body)
    if (typeMatch) {
      type = typeMatch[1]!.toLowerCase() as MemoryType
      body = typeMatch[2]!.trim()
    }
    if (!body) continue

    out.push({
      text: body,
      type,
      scope: currentScope,
      importance,
      ...(key ? { key } : {}),
      tags,
      ...(currentScope === "workspace" && currentTargetId ? { projectId: currentTargetId } : {}),
      ...(currentScope === "character" && currentTargetId ? { characterId: currentTargetId } : {}),
      ...(currentScope === "agent" && currentTargetId ? { agentId: currentTargetId } : {}),
      ...(projectMemoryKind ? { projectMemoryKind } : {}),
      ...(branch ? { branch } : {}),
      ...(pathPattern ? { pathPattern } : {}),
    })
  }
  return out
}

function sameImportNamespace(a: MemoryPortableItem, b: Memory): boolean {
  if (a.scope !== b.scope) return false
  if (a.scope === "workspace") return (a.projectId ?? "") === (b.projectId ?? "")
  if (a.scope === "character") return (a.characterId ?? "") === (b.characterId ?? "")
  if (a.scope === "agent") return (a.agentId ?? "") === (b.agentId ?? "")
  return true
}

function findMatchingMemory(
  candidate: MemoryPortableItem,
  existing: readonly Memory[]
): { kind: "duplicate" | "conflict"; memory: Memory } | undefined {
  const normCandidate = normalizeTextForComparison(candidate.text)
  const keyCandidate = candidate.key?.trim().toLowerCase()
  const candidateTerms = meaningfulTerms(candidate.text)

  let bestConflict: { memory: Memory; overlap: number } | undefined

  for (const row of existing) {
    if (row.status !== "active" || row.revisionOf !== undefined) continue
    if (!sameImportNamespace(candidate, row)) continue

    if (normalizeTextForComparison(row.text) === normCandidate) {
      return { kind: "duplicate", memory: row }
    }
    if (keyCandidate && row.key?.trim().toLowerCase() === keyCandidate) {
      return { kind: "conflict", memory: row }
    }

    if (candidateTerms.size >= 2) {
      const rowTerms = meaningfulTerms(row.text)
      if (rowTerms.size >= 2) {
        let shared = 0
        for (const term of candidateTerms) {
          if (rowTerms.has(term)) shared += 1
        }
        const union = candidateTerms.size + rowTerms.size - shared
        const jaccard = union > 0 ? shared / union : 0
        if (jaccard >= 0.5 && (!bestConflict || jaccard > bestConflict.overlap)) {
          bestConflict = { memory: row, overlap: jaccard }
        }
      }
    }
  }

  return bestConflict ? { kind: "conflict", memory: bestConflict.memory } : undefined
}

export function previewMemoryImport(
  raw: string,
  existing: readonly Memory[],
  options: PreviewMemoryImportOptions = {}
): MemoryImportPreview {
  const trimmed = raw.trim()
  const emptyCounts = {
    total: 0,
    add: 0,
    duplicate: 0,
    conflict: 0,
    blockedPii: 0,
    pendingReview: 0,
    sensitive: 0,
  }
  if (!trimmed) {
    return {
      ok: false,
      format: "invalid",
      error: "empty_input",
      items: [],
      counts: emptyCounts,
    }
  }

  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[")
  let format: "json" | "markdown" = looksJson ? "json" : "markdown"
  let parsedCandidates = looksJson ? parseJsonCandidates(trimmed) : null
  if (looksJson && parsedCandidates === null) {
    return {
      ok: false,
      format: "invalid",
      error: "invalid_json",
      items: [],
      counts: emptyCounts,
    }
  }
  if (!parsedCandidates) {
    format = "markdown"
    parsedCandidates = parseMarkdownCandidates(trimmed)
  }

  if (parsedCandidates.length === 0) {
    return {
      ok: false,
      format: "invalid",
      error: "no_memories_found",
      items: [],
      counts: emptyCounts,
    }
  }

  const items: MemoryImportPreviewItem[] = []
  const counts = { ...emptyCounts, total: parsedCandidates.length }

  parsedCandidates.forEach((rawCandidate, index) => {
    const scope = options.overrideScope ?? rawCandidate.scope
    const candidate: MemoryPortableItem = {
      ...rawCandidate,
      scope,
      projectId:
        scope === "workspace" ? (rawCandidate.projectId ?? options.defaultProjectId) : undefined,
      characterId:
        scope === "character"
          ? (rawCandidate.characterId ?? options.defaultCharacterId)
          : undefined,
      agentId: scope === "agent" ? (rawCandidate.agentId ?? options.defaultAgentId) : undefined,
    }

    const sensitivity = classifySensitiveMemoryTopic(candidate.text)
    const quarantineSensitive = sensitivity.sensitive && !options.allowSensitiveTopics
    const isProcedural = candidate.type === "procedural"
    const trustPosture: MemoryImportTrustPosture = quarantineSensitive
      ? "quarantined_sensitive"
      : isProcedural
        ? "pending_instruction"
        : "unreviewed"
    const effectiveReviewStatus: MemoryReviewStatus = isProcedural
      ? "pending_instruction"
      : "unreviewed"
    const effectiveTrustState: MemoryTrustState =
      quarantineSensitive || isProcedural ? "quarantined" : "untrusted"
    const effectiveSensitivity: MemorySensitivity = sensitivity.sensitive ? "sensitive" : "normal"

    if (options.isPiiSafe && !options.isPiiSafe(candidate.text)) {
      counts.blockedPii += 1
      items.push({
        index,
        candidate,
        disposition: "blocked_pii",
        trustPosture,
        sensitiveCategories: sensitivity.categories,
        effectiveReviewStatus,
        effectiveTrustState,
        effectiveSensitivity,
      })
      return
    }

    const match = findMatchingMemory(candidate, existing)
    const disposition: MemoryImportDisposition = match ? match.kind : "add"
    if (disposition === "add") counts.add += 1
    else if (disposition === "duplicate") counts.duplicate += 1
    else if (disposition === "conflict") counts.conflict += 1

    if (disposition !== "duplicate") {
      counts.pendingReview += 1
      if (sensitivity.sensitive) counts.sensitive += 1
    }

    items.push({
      index,
      candidate,
      disposition,
      ...(match ? { existingId: match.memory.id, existingText: match.memory.text } : {}),
      trustPosture,
      sensitiveCategories: sensitivity.categories,
      effectiveReviewStatus,
      effectiveTrustState,
      effectiveSensitivity,
    })
  })

  return {
    ok: true,
    format,
    items,
    counts,
  }
}
