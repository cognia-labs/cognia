/**
 * Oh My Pi (`oh-my-pi`) session-history source (#19).
 *
 * Reads OMP's JSONL DAG format (versions 1–3) stored under
 * `~/.omp/agent/sessions` (or `$PI_CODING_AGENT_SESSION_DIR` /
 * `$OMP_PROFILE` / `$PI_CONFIG_DIR` via `VendorRoots.ompSessionDir`).
 *
 * Kept self-contained in `lib/session-import` without pulling in the
 * unregistered `@cognia/agent-omp` RPC package.
 */

import type { ImportedConversation } from "@/lib/data/importers/types"
import type { SessionLossEntry } from "@cognia/agent-config-types/canonical-session"
import type {
  HistoryMessage,
  HistoryPart,
  HistoryToolPart,
  HistoryUsage,
  ParsedHistorySession,
} from "@cognia/agent-contracts/history"
import {
  deriveTitle,
  historyFile,
  historyReasoning,
  historyText,
  historyTool,
  stringifyToolResult,
} from "@cognia/agent-runtime-kit/history"
import { linearizeActiveLeaf } from "@cognia/agent-runtime-kit/history-dag"
import { joinPath } from "@/lib/agents/instructions/paths"
import { conversationToCanonical, type SessionCodec } from "../codec-types"
import { buildImportedSessionGraph } from "../graph"
import { historyMessagesToStored, historySummaryToSessionSummary } from "../history-to-stored"
import { scanFileSummaries } from "../scan"
import { buildSession, importedSessionId } from "../to-parts"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionDetectVerdict,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"

export const OH_MY_PI_SOURCE_ID = "oh-my-pi"
const VERIFIED_VERSION = "18.22.2"
const VERIFIED_AT = "2026-11-18"
const SUPPORTED_VERSIONS = new Set([1, 2, 3])
const OMP_DISTINCTIVE_TYPES = new Set([
  "title",
  "title_change",
  "mode_change",
  "reset_boundary",
  "session_init",
])
const OMP_DISTINCTIVE_ROLES = new Set(["bashExecution", "pythonExecution"])

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {}
}

function asStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asTime(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Date.parse(asStr(value) ?? "")
  return Number.isFinite(n) && Math.abs(n) <= 8_640_000_000_000_000 ? n : fallback
}

function asNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function parseParentId(value: unknown): string | undefined {
  const p = asStr(value)
  if (!p) return undefined
  if (!/[\\/]/.test(p)) return p
  const name = p
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.jsonl$/i, "")
  return name?.includes("_") ? name.slice(name.lastIndexOf("_") + 1) : name
}

function parseUsage(value: unknown): HistoryUsage | undefined {
  const u = asRecord(value)
  if (!Object.keys(u).length) return undefined
  const cost = asRecord(u.cost).total ?? u.cost
  return {
    inputTokens: asNum(u.input),
    outputTokens: asNum(u.output),
    cacheReadInputTokens: asNum(u.cacheRead),
    cacheCreationInputTokens: asNum(u.cacheWrite),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? { totalCostUsd: cost }
      : {}),
    ...(typeof u.reasoning === "number" ? { reasoningTokens: asNum(u.reasoning) } : {}),
  }
}

interface ParsedFile {
  header: RecordValue
  entries: RecordValue[]
  title?: string
  corruptLines: number
  version: number
}

function parseOmpJsonl(content: string): ParsedFile {
  const entries: RecordValue[] = []
  let header: RecordValue | undefined
  let title: string | undefined
  let corruptLines = 0
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        corruptLines++
        continue
      }
      const row = value as RecordValue
      if (row.type === "title") {
        title = asStr(row.title)
        continue
      }
      if (row.type === "session") {
        if (!header) header = row
        else corruptLines++
        continue
      }
      entries.push(row)
    } catch {
      corruptLines++
    }
  }
  if (!header) throw new Error("Missing oh-my-pi session header")
  const version = header.version ?? 1
  if (typeof version !== "number" || !SUPPORTED_VERSIONS.has(version)) {
    throw new Error(`Unsupported oh-my-pi session version: ${String(version)}`)
  }
  return { header, entries, title, corruptLines, version }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      const b = asRecord(block)
      return asStr(b.text) ?? ""
    })
    .filter(Boolean)
    .join("\n")
}

function linearizeEntries(entries: RecordValue[]): {
  active: RecordValue[]
  alternateBranches: Array<{ leafId: string; entries: RecordValue[] }>
} {
  const hasIds = entries.some((e) => typeof e.id === "string")
  if (!hasIds) {
    return { active: entries, alternateBranches: [] }
  }
  const nodes = entries.map((e, i) => ({
    uuid: asStr(e.id) ?? `line-${i}`,
    parentUuid: asStr(e.parentId) ?? null,
    timestamp: asStr(e.timestamp),
    entry: e,
  }))
  const activeNodes = linearizeActiveLeaf(nodes)
  const activeLeafId = activeNodes.at(-1)?.uuid

  const byId = new Map(nodes.map((n) => [n.uuid, n]))
  const parents = new Set<string>()
  for (const n of nodes) {
    if (n.parentUuid && byId.has(n.parentUuid)) parents.add(n.parentUuid)
  }
  const alternateLeaves = nodes.filter((n) => !parents.has(n.uuid) && n.uuid !== activeLeafId)
  const alternateBranches = alternateLeaves.map((leaf) => {
    const chain: RecordValue[] = []
    const visited = new Set<string>()
    let cur: (typeof nodes)[number] | undefined = leaf
    while (cur && !visited.has(cur.uuid)) {
      visited.add(cur.uuid)
      chain.push(cur.entry)
      cur = cur.parentUuid ? byId.get(cur.parentUuid) : undefined
    }
    return { leafId: leaf.uuid, entries: chain.reverse() }
  })

  return {
    active: activeNodes.map((n) => n.entry),
    alternateBranches,
  }
}

function buildBranchSession(
  header: RecordValue,
  branchEntries: RecordValue[],
  fileTitle: string | undefined,
  corruptLines: number,
  fallbackId: string
): ParsedHistorySession {
  const losses: SessionLossEntry[] = []
  if (corruptLines > 0) {
    losses.push({
      path: "jsonl.corruptLines",
      kind: "dropped",
      detail: `Skipped ${corruptLines} unreadable JSONL line(s).`,
    })
  }

  const createdAt = asTime(header.timestamp)
  let updatedAt = createdAt
  let model = asStr(header.model)
  let currentTitle = fileTitle ?? asStr(header.title)
  const messages: HistoryMessage[] = []
  const pendingTools = new Map<string, HistoryToolPart>()

  for (const entry of branchEntries) {
    const ts = asTime(entry.timestamp, updatedAt)
    if (ts > updatedAt) updatedAt = ts

    if (entry.type === "title_change" && fileTitle === undefined) {
      currentTitle = asStr(entry.title) ?? currentTitle
      continue
    }
    if (entry.type === "model_change") {
      const provider = asStr(entry.provider)
      const modelId = asStr(entry.modelId) ?? asStr(entry.model)
      if (modelId) model = provider ? `${provider}/${modelId}` : modelId
      continue
    }
    if (entry.type === "compaction") {
      const summary = asStr(entry.summary)
      if (summary) {
        messages.push({
          role: "system",
          createdAt: ts,
          parts: [historyText(`[Compaction summary]\n${summary}`)],
        })
      }
      continue
    }
    if (entry.type === "branch_summary") {
      const summary = asStr(entry.summary)
      if (summary) {
        messages.push({
          role: "system",
          createdAt: ts,
          parts: [historyText(`[Branch summary]\n${summary}`)],
        })
      }
      continue
    }
    if (entry.type === "custom_message") {
      const text = extractTextFromContent(entry.content)
      if (text) {
        messages.push({
          role: "user",
          createdAt: ts,
          parts: [historyText(text)],
        })
      }
      continue
    }
    if (entry.type !== "message") continue

    const msg = asRecord(entry.message)
    const role = asStr(msg.role)
    const msgTs = asTime(msg.timestamp, ts)
    if (msgTs > updatedAt) updatedAt = msgTs

    if (role === "toolResult") {
      const callId = asStr(msg.toolCallId) ?? asStr(msg.id)
      const output = stringifyToolResult(msg.content ?? msg.output ?? "")
      const isError = msg.isError === true
      const existing = callId ? pendingTools.get(callId) : undefined
      if (existing) {
        existing.result = isError ? { ok: false, errorText: output } : { ok: true, output }
        existing.status = isError ? "failed" : "completed"
      }
      continue
    }

    if (role === "bashExecution" || role === "pythonExecution") {
      const command = asStr(msg.command) ?? asStr(msg.code) ?? ""
      const output = asStr(msg.output) ?? ""
      const exitCode = typeof msg.exitCode === "number" ? msg.exitCode : undefined
      const isError = (exitCode !== undefined && exitCode !== 0) || msg.cancelled === true
      const toolPart = historyTool({
        toolCallId: asStr(entry.id) ?? `exec-${messages.length}`,
        name: role === "bashExecution" ? "bash" : "python",
        input: { command },
        result: isError
          ? { ok: false, errorText: output || `exit ${String(exitCode ?? "cancelled")}` }
          : { ok: true, output },
        status: isError ? "failed" : "completed",
      })
      messages.push({ role: "assistant", createdAt: msgTs, parts: [toolPart] })
      continue
    }

    if (role === "user") {
      const parts: HistoryPart[] = []
      if (typeof msg.content === "string") {
        if (msg.content) parts.push(historyText(msg.content))
      } else if (Array.isArray(msg.content)) {
        for (const raw of msg.content) {
          const block = asRecord(raw)
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            parts.push(historyText(block.text))
          } else if (block.type === "image" && typeof block.data === "string") {
            const mimeType = asStr(block.mimeType) ?? "image/png"
            parts.push(
              historyFile({
                url: block.data.startsWith("data:")
                  ? block.data
                  : `data:${mimeType};base64,${block.data}`,
                mediaType: mimeType,
                filename: asStr(block.name) ?? "image",
              })
            )
          }
        }
      }
      if (parts.length > 0) {
        messages.push({ role: "user", createdAt: msgTs, parts })
      }
      continue
    }

    if (role === "assistant") {
      const msgModel = asStr(msg.model)
      const msgProvider = asStr(msg.provider)
      if (msgModel) model = msgProvider ? `${msgProvider}/${msgModel}` : msgModel

      const parts: HistoryPart[] = []
      if (typeof msg.content === "string") {
        if (msg.content) parts.push(historyText(msg.content))
      } else if (Array.isArray(msg.content)) {
        for (const raw of msg.content) {
          const block = asRecord(raw)
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            parts.push(historyText(block.text))
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            parts.push(historyReasoning(block.thinking))
          } else if (block.type === "toolCall") {
            const callId = asStr(block.id) ?? `call-${parts.length}`
            const toolPart = historyTool({
              toolCallId: callId,
              name: asStr(block.name) ?? "tool",
              input: asRecord(block.arguments),
            })
            pendingTools.set(callId, toolPart)
            parts.push(toolPart)
          }
        }
      }
      const usage = parseUsage(msg.usage)
      if (parts.length > 0 || usage) {
        messages.push({
          role: "assistant",
          createdAt: msgTs,
          parts,
          ...(msgModel ? { usageModel: msgModel } : {}),
          ...(usage ? { usage } : {}),
        })
      }
    }
  }

  const firstUserText =
    messages
      .find((m) => m.role === "user")
      ?.parts.map((p) => (p.type === "text" ? p.text : ""))
      .join(" ") ?? ""

  const parentNativeSessionId = parseParentId(header.parentSession)

  return {
    sourceId: OH_MY_PI_SOURCE_ID,
    originalSessionId: asStr(header.id) ?? fallbackId,
    title: currentTitle ?? deriveTitle(firstUserText, "oh-my-pi session"),
    ...(model ? { model } : {}),
    ...(asStr(header.cwd) ? { cwd: asStr(header.cwd) } : {}),
    createdAt,
    updatedAt,
    messages,
    goals: [],
    plans: [],
    tasks: [],
    history: [],
    interAgentMessages: [],
    recordedEvents: [],
    losses,
    sourceVersion: String(header.version ?? 1),
    ...(parentNativeSessionId ? { parentNativeSessionId, relationKind: "fork" as const } : {}),
  }
}

export function summarizeOhMyPiFile(content: string, locator: string): SessionSummary | null {
  try {
    const parsed = parseOmpJsonl(content)
    const { active } = linearizeEntries(parsed.entries)
    let first = ""
    let messageCount = 0
    let updatedAt = asTime(parsed.header.timestamp)
    let currentTitle = parsed.title ?? asStr(parsed.header.title)

    for (const entry of active) {
      updatedAt = Math.max(updatedAt, asTime(entry.timestamp))
      if (entry.type === "title_change" && parsed.title === undefined) {
        currentTitle = asStr(entry.title) ?? currentTitle
      }
      const msg = asRecord(entry.message)
      if (
        entry.type === "custom_message" ||
        entry.type === "compaction" ||
        entry.type === "branch_summary" ||
        (entry.type === "message" && msg.role !== "toolResult")
      ) {
        messageCount++
      }
      if (!first && msg.role === "user") {
        first = extractTextFromContent(msg.content)
      }
    }

    const parentNativeSessionId = parseParentId(parsed.header.parentSession)
    return historySummaryToSessionSummary(
      {
        sourceId: OH_MY_PI_SOURCE_ID,
        originalSessionId: asStr(parsed.header.id) ?? locator,
        title: currentTitle ?? deriveTitle(first, "oh-my-pi session"),
        messageCount,
        updatedAt,
        ...(asStr(parsed.header.cwd) ? { cwd: asStr(parsed.header.cwd) } : {}),
        sourceVersion: String(parsed.header.version ?? 1),
        ...(parentNativeSessionId ? { parentNativeSessionId, relationKind: "fork" as const } : {}),
      },
      locator
    )
  } catch {
    return null
  }
}

export function detectOhMyPiSession(files: readonly PickedSessionFile[]): SessionDetectVerdict {
  if (!files.length) return "no"
  let native = 0
  let ambiguous = 0
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".jsonl")) continue
    const normalized = file.path.replace(/\\/g, "/")
    if (normalized.includes("/.pi/")) continue
    try {
      const parsed = parseOmpJsonl(file.content)
      const isOmpDistinctive =
        parsed.title !== undefined ||
        parsed.entries.some(
          (e) =>
            OMP_DISTINCTIVE_TYPES.has(asStr(e.type) ?? "") ||
            OMP_DISTINCTIVE_ROLES.has(asStr(asRecord(e.message).role) ?? "")
        )
      if (normalized.includes("/.omp/") || isOmpDistinctive) native++
      else ambiguous++
    } catch {
      /* Not an OMP JSONL transcript. */
    }
  }
  return native === files.length ? "match" : native + ambiguous > 0 ? "maybe" : "no"
}

async function readFile(input: SessionScanInput, locator: string): Promise<string> {
  const picked = input.pickedFiles?.find((file) => file.path === locator)
  if (picked) return picked.content
  return input.fs.readTextFile(locator)
}

function ohMyPiResumeBinding(parsed: ParsedHistorySession) {
  return {
    presetId: "oh-my-pi",
    nativeSessionId: parsed.originalSessionId,
    cwd: parsed.cwd,
    resumeMethod: "api" as const,
    verifiedAt: VERIFIED_AT,
  }
}

function ohMyPiConversation(
  ref: SessionRef,
  content: string
): { conversation: ImportedConversation; losses: Map<string, SessionLossEntry[]> } {
  const parsed = parseOmpJsonl(content)
  const { active, alternateBranches } = linearizeEntries(parsed.entries)
  const main = buildBranchSession(
    parsed.header,
    active,
    parsed.title,
    parsed.corruptLines,
    ref.originalSessionId
  )
  const sessionId = importedSessionId(OH_MY_PI_SOURCE_ID, main.originalSessionId)
  const losses = new Map<string, SessionLossEntry[]>([[sessionId, main.losses]])

  const messages = historyMessagesToStored(sessionId, main.messages)
  const session = buildSession({
    id: sessionId,
    title: main.title,
    ...(main.model ? { model: main.model } : {}),
    ...(main.cwd ? { workingDir: main.cwd } : {}),
    createdAt: main.createdAt,
    updatedAt: main.updatedAt,
    seedMessages: messages,
  })
  session.importRuntimeBinding = ohMyPiResumeBinding(main)
  if (main.relationKind === "fork") {
    session.importRelation = {
      kind: "fork",
      ...(main.parentNativeSessionId ? { parentNativeSessionId: main.parentNativeSessionId } : {}),
    }
  }

  const nested: ImportedConversation[] = []
  for (const branch of alternateBranches) {
    const branchSessionId = `${sessionId}:branch:${branch.leafId}`
    const branchParsed = buildBranchSession(
      parsed.header,
      branch.entries,
      parsed.title,
      0,
      `${main.originalSessionId}:branch:${branch.leafId}`
    )
    const branchMessages = historyMessagesToStored(branchSessionId, branchParsed.messages)
    const branchSession = buildSession({
      id: branchSessionId,
      title: branchParsed.title,
      ...(branchParsed.model ? { model: branchParsed.model } : {}),
      ...(branchParsed.cwd ? { workingDir: branchParsed.cwd } : {}),
      createdAt: branchParsed.createdAt,
      updatedAt: branchParsed.updatedAt,
      seedMessages: branchMessages,
    })
    branchSession.parentSessionId = sessionId
    branchSession.importRelation = {
      kind: "branch",
      parentNativeSessionId: main.originalSessionId,
    }
    branchSession.importRuntimeBinding = ohMyPiResumeBinding(branchParsed)
    nested.push({ session: branchSession, messages: branchMessages })
    losses.set(branchSessionId, branchParsed.losses)
  }

  return {
    conversation: { session, messages, ...(nested.length > 0 ? { nested } : {}) },
    losses,
  }
}

export function parseOhMyPiSession(ref: SessionRef, content: string): ImportedConversation {
  return ohMyPiConversation(ref, content).conversation
}

/** Import-only structured codec (no materialize; reverse replay is not declared). */
export const ohMyPiCodec: SessionCodec = {
  importFidelity: "structured",
  toCanonical(conversation: ImportedConversation) {
    return conversationToCanonical(conversation, {
      sourceRuntime: OH_MY_PI_SOURCE_ID,
      importFidelity: "structured",
    })
  },
}

export const ohMyPiSessionSource: AgentSessionSourceAdapter = {
  id: OH_MY_PI_SOURCE_ID,
  displayName: "oh-my-pi",
  labelKey: "oh-my-pi",
  verifiedVersion: VERIFIED_VERSION,
  verifiedAt: VERIFIED_AT,
  acceptedExtensions: [".jsonl"],

  scanRoots(home, roots) {
    const sessions = roots?.ompSessionDir || (home ? joinPath(home, ".omp/agent/sessions") : "")
    return sessions ? [sessions] : []
  },

  detect(files: PickedSessionFile[]): SessionDetectVerdict {
    return detectOhMyPiSession(files)
  },

  async listSessions(input: SessionScanInput): Promise<SessionSummary[]> {
    return scanFileSummaries(
      input,
      this.scanRoots(input.home, input.roots),
      (path) => path.endsWith(".jsonl"),
      summarizeOhMyPiFile
    )
  },

  async parseSession(ref: SessionRef, input: SessionScanInput): Promise<ImportedConversation> {
    return parseOhMyPiSession(ref, await readFile(input, ref.locator))
  },

  async parseGraph(ref: SessionRef, input: SessionScanInput) {
    const { conversation, losses } = ohMyPiConversation(ref, await readFile(input, ref.locator))
    const graph = buildImportedSessionGraph(conversation, {
      sourceRuntime: this.id,
      sourceVersion: this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: this.codec?.importFidelity ?? "structured",
      codec: this.codec,
    })
    for (const node of graph.nodes) {
      const nodeLosses = losses.get(node.conversation.session.id) ?? []
      node.loss.losses.push(...nodeLosses.map((loss) => ({ ...loss })))
    }
    return graph
  },

  summarizeFile: summarizeOhMyPiFile,
  codec: ohMyPiCodec,
}
