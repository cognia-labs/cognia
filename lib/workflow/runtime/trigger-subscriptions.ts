/**
 * Trigger subscription cache — keeps an in-memory index of every PUBLISHED
 * workflow's TS-hook trigger nodes so callers along the chat-send,
 * inbound-bus, terminal-command, and goal-completion paths can route to
 * matching workflows in a single map lookup instead of scanning Dexie on every
 * event.
 *
 * The index is built from the ACTIVE production deployments of the current
 * account and the immutable version each one points at — the same artifact
 * `executeDeployedWorkflow` admits. It used to be built from the `workflows`
 * draft rows, so saving a draft (without publishing) changed which events
 * matched while admission still ran the published version: the old filter
 * stopped firing and the new one started the old graph. A Dexie `liveQuery`
 * over `workflowDeployments` + `workflowVersions` rebuilds the index on every
 * publish, unpublish and rollback. `WorkflowRuntimeProvider` (and the brain's
 * workflow runtime) call `initTriggerSubscriptions()` once on boot;
 * `disposeTriggerSubscriptions()` unwinds the subscription.
 *
 * The cache is intentionally only used for triggers that ride existing TS
 * hooks. `trigger.cron` and webhook triggers go through the Rust router, so
 * they don't need this lookup table.
 */

import Dexie, { type Subscription } from "dexie"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

export interface SubscribedTrigger {
  workflowId: string
  nodeId: string
  params: Record<string, unknown>
}

/** Kinds we actually index — cron/webhook triggers go through the Rust router. */
const INDEXED_KINDS: readonly WorkflowNodeKind[] = [
  "trigger.connector.inbound",
  "trigger.connector.system",
  "trigger.chat.message",
  "trigger.goal.completed",
  "trigger.terminal.command",
  "trigger.team",
  "trigger.desktop.event",
  "trigger.pet.event",
  "trigger.issue.event",
  "trigger.workflow.completed",
  "trigger.integration.event",
  "trigger.plan.event",
  "trigger.scheduler.taskCompleted",
  "trigger.capture.item",
  "trigger.memory.written",
]

interface SubscriptionState {
  byKind: Map<WorkflowNodeKind, SubscribedTrigger[]>
  subscription?: Subscription
}

const state: SubscriptionState = { byKind: new Map() }

/** One published definition the index is built from. */
export interface DeployedTriggerDefinition {
  workflowId: string
  /** The immutable version's definition — what admission will execute. */
  definition: Pick<VisualWorkflow, "nodes" | "isTemplate" | "isBuiltIn">
}

function rebuildIndex(rows: readonly DeployedTriggerDefinition[]): void {
  const next = new Map<WorkflowNodeKind, SubscribedTrigger[]>()
  for (const kind of INDEXED_KINDS) next.set(kind, [])
  for (const { workflowId, definition } of rows) {
    if (definition.isTemplate || definition.isBuiltIn) continue
    for (const node of definition.nodes) {
      if (node.data.disabled || !INDEXED_KINDS.includes(node.type)) continue
      const params = (node.data?.params ?? {}) as Record<string, unknown>
      next.get(node.type)!.push({
        workflowId,
        nodeId: node.id,
        params,
      })
    }
  }
  state.byKind = next
}

/**
 * Read every active production deployment of the active account together
 * with the version it selects. A pointer whose version is missing or belongs
 * to another workflow/account is skipped: admission would refuse it too.
 * Reading both tables inside the liveQuery makes Dexie observe both, so a
 * publish (new version + moved pointer), an unpublish (pointer disabled) or a
 * rollback (pointer moved back) all re-emit.
 */
export async function readDeployedTriggerDefinitions(): Promise<DeployedTriggerDefinition[]> {
  const db = getDb()
  const accountId = getActiveAccountId()
  const deployments = (await db.workflowDeployments.where("status").equals("active").toArray())
    .filter(
      (deployment) => deployment.accountId === accountId && deployment.environment === "production"
    )
    .sort((a, b) => a.workflowId.localeCompare(b.workflowId))
  if (deployments.length === 0) return []
  const versions = await db.workflowVersions.bulkGet(deployments.map((d) => d.versionId))
  const rows: DeployedTriggerDefinition[] = []
  deployments.forEach((deployment, index) => {
    const version = versions[index]
    if (
      !version ||
      version.workflowId !== deployment.workflowId ||
      version.accountId !== deployment.accountId
    ) {
      return
    }
    rows.push({ workflowId: deployment.workflowId, definition: version.definition })
  })
  return rows
}

/**
 * Open the liveQuery. Idempotent — calling twice closes the previous
 * subscription before opening a new one.
 */
export function initTriggerSubscriptions(): void {
  if (typeof window === "undefined") return
  disposeTriggerSubscriptions()
  try {
    // `Dexie.liveQuery`, not a named `liveQuery` import. Dexie's CJS build (what
    // Jest resolves) defines `liveQuery` as a NON-ENUMERABLE property of
    // `module.exports` and sets no `__esModule` marker. Importing the `Dexie`
    // default alongside it, as this module now does, routes the module through
    // SWC's `_interop_require_wildcard`, which copies enumerable keys only, so a
    // named `liveQuery` binding would silently be `undefined`. The static is the
    // same function (`Dexie.liveQuery === liveQuery` under real ESM) and is
    // correct through either path.
    const observable = Dexie.liveQuery(() => readDeployedTriggerDefinitions())
    state.subscription = observable.subscribe({
      next: (rows) => {
        rebuildIndex(rows)
      },
      error: (err) => {
        log.warn?.("trigger-subscriptions: liveQuery error", {
          error: err instanceof Error ? err.message : String(err),
        })
      },
    })
  } catch (err) {
    log.warn?.("trigger-subscriptions: subscribe failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Close the liveQuery and reset the cache. */
export function disposeTriggerSubscriptions(): void {
  if (state.subscription) {
    try {
      state.subscription.unsubscribe()
    } catch {
      // best-effort
    }
    state.subscription = undefined
  }
  state.byKind = new Map()
}

/**
 * Context passed by the inbound bus / chat send pipeline. Each property is
 * matched against the corresponding trigger node's params with these rules:
 *
 *   • `adapterId` (connector.inbound) — required match
 *   • `conversationKey` (connector.inbound) — optional match. If the
 *     trigger node didn't specify one, it matches any conversation.
 *   • `characterId` (chat.message) — required match
 *   • `sessionId` (chat.message) — optional. Trigger may scope to a single
 *     session; if unspecified, matches all sessions for the character.
 */
export interface TriggerMatchContext {
  adapterId?: string
  conversationKey?: string
  characterId?: string
  sessionId?: string
  /** Goal id (goal.completed) — optional match; unspecified node matches any goal. */
  goalId?: string
  /**
   * Source workflow id (workflow.completed) — matched against the node's
   * `workflowId` param. A node without the filter matches EVERY workflow's
   * terminal run (self-triggering is still rejected by the fanout emitter).
   */
  sourceWorkflowId?: string
  /**
   * Outcome status — goal.completed sends the terminal goal status (e.g.
   * "completed"); terminal.command sends "success" / "failure". Optional
   * equality match against the node's `status` param.
   */
  status?: string
  /** Project id (terminal.command) — optional equality match. */
  projectId?: string
  /** Team id (trigger.team) — optional; unspecified node matches any team. */
  teamId?: string
  /**
   * Desktop UI event kind (trigger.desktop.event) — matched against the
   * node's `kinds` array param ("focus-changed" / …). A node without a
   * `kinds` filter matches every event kind.
   */
  desktopEventKind?: string
  /**
   * Pet lifecycle event kind (trigger.pet.event) — matched against the
   * node's `kinds` array param (levelUp / evolved / achievementUnlocked /
   * unwell). A node without a `kinds` filter matches every lifecycle kind.
   */
  petEventKind?: string
  /**
   * Issue trail event kind (trigger.issue.event): created / status_changed /
   * assigned / commented / run_succeeded / ... matched against the node's
   * `kinds` array param. A node without a `kinds` filter matches every kind.
   */
  issueEventKind?: string
  /** Container of the issue (trigger.issue.event), matched against `issueProjectId`. */
  issueProjectId?: string
  /**
   * Plan trail event kind (trigger.plan.event): approved / step_failed /
   * exit / ... matched against the node's `kinds` array param.
   */
  planEventKind?: string
  /** The plan itself (trigger.plan.event) — optional equality match. */
  planId?: string
  /** How the plan was authored (trigger.plan.event) — optional equality match. */
  planSource?: string
  /** The settled task (trigger.scheduler.taskCompleted) — optional equality. */
  taskId?: string
  /** Its type, matched against the node's `taskTypes` array param. */
  taskType?: string
  /** Its structured terminal reason, matched against `terminalReasons`. */
  terminalReason?: string
  /**
   * Captured item kind (trigger.capture.item): text / url / image, matched
   * against the node's `kinds` array param.
   */
  captureItemKind?: string
  /** Source application, matched as a substring against `sourceAppContains`. */
  sourceApp?: string
  /** Host of the source url, matched as a substring against `urlHostContains`. */
  urlHost?: string
  /** Whether the capture was enriched, matched against `enrichedOnly`. */
  hasEnrichment?: boolean
  /** Memory classification (trigger.memory.written), matched against arrays. */
  memoryType?: string
  memoryScope?: string
  memoryProvenance?: string
  /** Memory importance, matched against the node's `minImportance`. */
  importance?: number
  /** The author's dedupe slug, matched as a prefix against `keyPrefix`. */
  memoryKey?: string
  /** Agent that owns the memory, matched against `agentId`. */
  agentId?: string
  /**
   * Platform system-event kind (trigger.connector.system) — reaction_added /
   * reaction_removed / poke / request / lifecycle, matched against the node's
   * `kinds` array param. A node without a `kinds` filter matches every kind.
   */
  connectorSystemKind?: string
  /**
   * Whether the system event's target message was delivered by the bot
   * (trigger.connector.system) — a node with `targetSelfOnly: true` only
   * fires when this is true.
   */
  targetDeliveredByUs?: boolean
  /**
   * Command line (terminal.command) — matched as a *substring* against the
   * node's `commandContains` param. Already PII-gated by the dispatcher;
   * an empty string only matches nodes without a `commandContains` filter.
   */
  command?: string
  /**
   * Platform sender id (connector.inbound) — matched against the node's
   * `senderIds` array param (OR). A node without the filter matches any
   * sender.
   */
  senderId?: string
  /**
   * Channel kind (connector.inbound) — private / group / channel / thread,
   * matched against the node's `channelKinds` array param.
   */
  channelKind?: string
  /**
   * Message plain text (connector.inbound) — matched case-insensitively as
   * a substring against the node's `keywords` array param (OR).
   */
  plainText?: string
  /**
   * Whether the bot itself was @-mentioned (connector.inbound) — a node
   * with `requireMention: true` only fires when this is true.
   */
  selfMentioned?: boolean
  /** Marketplace integration identifiers and normalized event filters. */
  pluginId?: string
  integrationId?: string
  accountId?: string
  eventType?: string
  resourceKind?: string
  resourceId?: string
}

/**
 * Return the list of triggers that match `kind + ctx`. Synchronous — reads
 * the in-memory cache. Returns an empty array when nothing matches or the
 * cache hasn't been populated yet.
 */
export function findMatchingWorkflows(
  kind: WorkflowNodeKind,
  ctx: TriggerMatchContext = {}
): SubscribedTrigger[] {
  const list = state.byKind.get(kind) ?? []
  if (list.length === 0) return []
  return list.filter((entry) => matches(entry, ctx))
}

function matches(entry: SubscribedTrigger, ctx: TriggerMatchContext): boolean {
  const p = entry.params
  if (typeof p.adapterId === "string" && p.adapterId.length > 0) {
    if (ctx.adapterId !== p.adapterId) return false
  }
  if (typeof p.conversationKey === "string" && p.conversationKey.length > 0) {
    if (ctx.conversationKey !== p.conversationKey) return false
  }
  if (typeof p.characterId === "string" && p.characterId.length > 0) {
    if (ctx.characterId !== p.characterId) return false
  }
  if (typeof p.sessionId === "string" && p.sessionId.length > 0) {
    if (ctx.sessionId !== p.sessionId) return false
  }
  if (typeof p.goalId === "string" && p.goalId.length > 0) {
    if (ctx.goalId !== p.goalId) return false
  }
  // workflow.completed: the node's `workflowId` param scopes to ONE source
  // workflow; entries are partitioned per kind so this never collides with
  // other kinds' params.
  if (typeof p.workflowId === "string" && p.workflowId.length > 0) {
    if (ctx.sourceWorkflowId !== p.workflowId) return false
  }
  if (typeof p.status === "string" && p.status.length > 0) {
    if (ctx.status !== p.status) return false
  }
  if (typeof p.projectId === "string" && p.projectId.length > 0) {
    if (ctx.projectId !== p.projectId) return false
  }
  if (typeof p.teamId === "string" && p.teamId.length > 0) {
    if (ctx.teamId !== p.teamId) return false
  }
  if (Array.isArray(p.kinds) && p.kinds.length > 0) {
    // Shared `kinds` filter shape — desktop and pet triggers each pass their
    // own ctx field, and entries are already partitioned per trigger kind.
    const eventKind =
      ctx.desktopEventKind ??
      ctx.petEventKind ??
      ctx.connectorSystemKind ??
      ctx.issueEventKind ??
      ctx.planEventKind ??
      ctx.captureItemKind
    if (typeof eventKind !== "string" || !p.kinds.includes(eventKind)) {
      return false
    }
  }
  if (typeof p.issueProjectId === "string" && p.issueProjectId.length > 0) {
    if (ctx.issueProjectId !== p.issueProjectId) return false
  }
  if (typeof p.planId === "string" && p.planId.length > 0) {
    if (ctx.planId !== p.planId) return false
  }
  if (typeof p.source === "string" && p.source.length > 0) {
    if (ctx.planSource !== p.source) return false
  }
  if (typeof p.taskId === "string" && p.taskId.length > 0) {
    if (ctx.taskId !== p.taskId) return false
  }
  if (Array.isArray(p.taskTypes) && p.taskTypes.length > 0) {
    if (typeof ctx.taskType !== "string" || !p.taskTypes.includes(ctx.taskType)) return false
  }
  if (Array.isArray(p.terminalReasons) && p.terminalReasons.length > 0) {
    if (typeof ctx.terminalReason !== "string" || !p.terminalReasons.includes(ctx.terminalReason)) {
      return false
    }
  }
  if (typeof p.sourceAppContains === "string" && p.sourceAppContains.length > 0) {
    if (typeof ctx.sourceApp !== "string" || !ctx.sourceApp.includes(p.sourceAppContains)) {
      return false
    }
  }
  if (typeof p.urlHostContains === "string" && p.urlHostContains.length > 0) {
    if (typeof ctx.urlHost !== "string" || !ctx.urlHost.includes(p.urlHostContains)) return false
  }
  if (p.enrichedOnly === true && ctx.hasEnrichment !== true) return false
  if (Array.isArray(p.types) && p.types.length > 0) {
    if (typeof ctx.memoryType !== "string" || !p.types.includes(ctx.memoryType)) return false
  }
  if (Array.isArray(p.scopes) && p.scopes.length > 0) {
    if (typeof ctx.memoryScope !== "string" || !p.scopes.includes(ctx.memoryScope)) return false
  }
  if (Array.isArray(p.provenances) && p.provenances.length > 0) {
    if (typeof ctx.memoryProvenance !== "string" || !p.provenances.includes(ctx.memoryProvenance)) {
      return false
    }
  }
  if (typeof p.minImportance === "number") {
    if (typeof ctx.importance !== "number" || ctx.importance < p.minImportance) return false
  }
  if (typeof p.keyPrefix === "string" && p.keyPrefix.length > 0) {
    if (typeof ctx.memoryKey !== "string" || !ctx.memoryKey.startsWith(p.keyPrefix)) return false
  }
  if (typeof p.agentId === "string" && p.agentId.length > 0) {
    if (ctx.agentId !== p.agentId) return false
  }
  if (typeof p.commandContains === "string" && p.commandContains.length > 0) {
    if (typeof ctx.command !== "string" || !ctx.command.includes(p.commandContains)) return false
  }
  // connector.inbound fine-grained filters (all optional).
  if (Array.isArray(p.senderIds) && p.senderIds.length > 0) {
    if (typeof ctx.senderId !== "string" || !p.senderIds.includes(ctx.senderId)) return false
  }
  if (Array.isArray(p.channelKinds) && p.channelKinds.length > 0) {
    if (typeof ctx.channelKind !== "string" || !p.channelKinds.includes(ctx.channelKind)) {
      return false
    }
  }
  if (Array.isArray(p.keywords) && p.keywords.length > 0) {
    const text = (ctx.plainText ?? "").toLowerCase()
    const hit = p.keywords.some(
      (k) => typeof k === "string" && k.length > 0 && text.includes(k.toLowerCase())
    )
    if (!hit) return false
  }
  if (p.requireMention === true && ctx.selfMentioned !== true) return false
  if (p.targetSelfOnly === true && ctx.targetDeliveredByUs !== true) return false
  if (typeof p.pluginId === "string" && p.pluginId.length > 0 && ctx.pluginId !== p.pluginId) {
    return false
  }
  if (
    typeof p.integrationId === "string" &&
    p.integrationId.length > 0 &&
    ctx.integrationId !== p.integrationId
  ) {
    return false
  }
  if (typeof p.accountId === "string" && p.accountId.length > 0 && ctx.accountId !== p.accountId) {
    return false
  }
  if (Array.isArray(p.eventTypes) && p.eventTypes.length > 0) {
    if (typeof ctx.eventType !== "string" || !p.eventTypes.includes(ctx.eventType)) return false
  }
  if (
    typeof p.resourceKind === "string" &&
    p.resourceKind.length > 0 &&
    ctx.resourceKind !== p.resourceKind
  ) {
    return false
  }
  if (
    typeof p.resourceId === "string" &&
    p.resourceId.length > 0 &&
    ctx.resourceId !== p.resourceId
  ) {
    return false
  }
  return true
}

/**
 * Test-only — directly seed the cache without going through Dexie. Each
 * workflow stands for its published definition (as if deployed as-is).
 */
export function _seedTriggerSubscriptionsForTest(
  rows: ReadonlyArray<Pick<VisualWorkflow, "id" | "nodes" | "isTemplate" | "isBuiltIn">>
): void {
  rebuildIndex(rows.map((row) => ({ workflowId: row.id, definition: row })))
}

/** Test-only — peek at the current cache. */
export function _peekTriggerSubscriptions(): ReadonlyMap<WorkflowNodeKind, SubscribedTrigger[]> {
  return state.byKind
}
