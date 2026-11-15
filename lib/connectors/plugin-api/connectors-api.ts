import { preparePluginHistory } from "@/lib/execution/personal-visibility"
import {
  executeConnectorManagement,
  listConnectorManagementOperations,
  connectorManagementIsRead,
} from "@/lib/connectors/management"
/**
 * Plugin Connectors API (`ctx.connectors`) — the full plugin-facing surface
 * of the Platform Connectors / IM subsystem. Lets plugins enumerate the
 * user's connected platforms, observe inbound messages **and** interactive
 * callbacks, drive outbound messaging (send / edit / delete / typing /
 * upload), read history + runtime health, and — behind a separate dangerous
 * permission — manage the adapter instance configuration itself.
 *
 * Wraps the connector `ConnectorBus` (`lib/connectors/bus.ts`), the
 * `adapterInstances` Dexie table (`lib/db/adapter-instances.ts`), and the
 * outbound runner's runtime-state snapshot
 * (`lib/connectors/outbound-runner.ts`).
 *
 * PERMISSION MODEL (three tiers, gated via `createGuardedAPI`):
 *  - `connectors:read`   — read-only: list adapters + instances, observe
 *    inbound/callbacks, fetch history, read runtime health. Returns only
 *    credential-free summaries — never the live `PlatformAdapter` (whose
 *    `start`/`stop`/`refreshCredentials` could be abused) and never the
 *    instance's `credentialsRef` (the OS-keyring pointer).
 *  - `connectors:send`   — DANGEROUS: outbound mutations that reach real
 *    people on real platforms and can't be recalled (send/edit/delete/
 *    typing/upload).
 *  - `connectors:manage` — DANGEROUS: create / reconfigure / enable /
 *    delete the user's adapter instances (changes live delivery routing),
 *    replace dispatch-rule tables, pre-mint conversations, and drive the
 *    capability-gated chat-management surface (create/update chats, manage
 *    members, resolve contacts — the last one deliberately confirm-tier
 *    because directory lookups expose personal data).
 *
 * Multi-bot surfaces: session bindings (`findSessionByConversation` /
 * `listSiblingConversations`), running-adapter enumeration, dispatch-rule
 * read/dry-run/replace, at-gate dry-run, and a durable queue-backed
 * `enqueueSend` (PII-gated, `source: "plugin"`).
 *
 * All observers (`onInbound`/`onCallback`) are passive read-only taps; they
 * run before the authoritative routing/handler and cannot alter it.
 */

import { getBus } from "@/lib/connectors/bus"
import { pluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
import {
  checkPersonalSink,
  personalSinkContextForRun,
  explicitHostPersonalSinkContext,
} from "@/lib/execution/personal-sink"
import { personalDeliveryNotice } from "@/lib/connectors/personal-delivery"
import { getDb } from "@/lib/db/schema"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import {
  findSessionByConversationKey,
  listSessionsByConversationKey,
  listSiblingConversations,
} from "@/lib/connectors/session-bindings"
import { bootstrapConversation } from "@/lib/connectors/conversation-bootstrap"
import { getRunningAdapter, listRunningAdapters } from "@/lib/connectors/lifecycle"
import { matchDispatchRule } from "@/lib/connectors/dispatch-rules"
import { shouldRespondToMessage } from "@/lib/connectors/at-gate"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import { requireMethod, withScopeCapture } from "@/lib/skills/built-in/im/_helpers"
import {
  ConnectorDeliveryHeldError,
  ConnectorDeliveryPiiError,
  getConnectorDeliveryGateway,
} from "@/lib/connectors/delivery-gateway"
import { pluginDestination, PluginDestinationError } from "@/lib/connectors/plugin-destination"
import { assertNoAddedUrgentReach } from "@/lib/connectors/escalation/policy"
import { createA2UIBuilder } from "@/lib/connectors/a2ui-bridge/surface-builder"
import {
  createAdapterInstance,
  updateAdapterInstance,
  getAdapterInstance,
  listAdapterInstances,
} from "@/lib/db/adapter-instances"
import { removeAdapterInstance } from "@/lib/connectors/remove-adapter-instance"
import { getAdapterRuntimeStateSnapshot } from "@/lib/connectors/outbound-runner"
import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { ChatSession } from "@cognia/agent-config-types"
import type { OutboundRequest, PlatformAdapter, Capability } from "@/types/connectors"
import type {
  PluginAdapterInstanceInfo,
  PluginBoundSessionInfo,
  PluginConnectorAdapterInfo,
  PluginConnectorsAPI,
  PluginOutboundJobStatus,
} from "@cognia/plugin-contract/lib/plugin/api/connectors-api"
export type {
  PluginAdapterInstanceInfo,
  PluginAdapterInstanceInput,
  PluginAdapterInstancePatch,
  PluginBoundSessionInfo,
  PluginConnectorAdapterInfo,
  PluginConnectorAdapterSupport,
  PluginConnectorsAPI,
  PluginOutboundJobInfo,
  PluginOutboundJobStatus,
} from "@cognia/plugin-contract/lib/plugin/api/connectors-api"

export type { PluginConnectorsA2UIBuilder } from "@/lib/connectors/a2ui-bridge/surface-builder"
export type { SiblingConversation } from "@/lib/connectors/session-bindings"
export type { DispatchRuleHit } from "@/lib/connectors/dispatch-rules"
export type { AtGateDecision } from "@/lib/connectors/at-gate"
export type {
  BootstrapConversationInput,
  BootstrapConversationResult,
} from "@/lib/connectors/conversation-bootstrap"

function toJobStatus(row: OutboundJobRow): PluginOutboundJobStatus {
  return {
    jobId: row.id,
    adapterId: row.adapterId,
    conversationKey: row.conversationKey,
    status: row.status,
    nextAttemptAt: row.nextAttemptAt,
    idempotencyKey: row.idempotencyKey,
    attempts: row.attempts,
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.lastErrorCode !== undefined ? { lastErrorCode: row.lastErrorCode } : {}),
    ...(row.platformMessageId !== undefined ? { platformMessageId: row.platformMessageId } : {}),
    ...(row.pendingReceipt ? { pendingReceipt: { ...row.pendingReceipt } } : {}),
    ...(row.reroutedToJobId !== undefined ? { reroutedToJobId: row.reroutedToJobId } : {}),
  }
}

function toBoundSessionInfo(s: ChatSession): PluginBoundSessionInfo {
  return {
    sessionId: s.id,
    title: s.title,
    conversationKey: s.platformConversationKey ?? s.platformBinding?.conversationKey ?? "",
    ...(s.characterId ? { characterId: s.characterId } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

function toInfo(a: PlatformAdapter): PluginConnectorAdapterInfo {
  return {
    id: a.id,
    type: a.meta.type,
    displayName: a.meta.displayName,
    version: a.meta.version,
    capabilities: a.meta.capabilities,
    transportModes: a.meta.transportModes,
    health: a.health(),
    supports: {
      edit: typeof a.edit === "function",
      delete: typeof a.delete === "function",
      setTyping: typeof a.setTyping === "function",
      uploadFile: typeof a.uploadFile === "function",
      fetchHistory: typeof a.fetchHistory === "function",
      streamReply: typeof a.streamReply === "function",
    },
  }
}

/** Strip the keyring pointer before any instance row crosses the plugin boundary. */
function toInstanceInfo(row: AdapterInstanceRow): PluginAdapterInstanceInfo {
  const copy: Partial<AdapterInstanceRow> = { ...row }
  delete copy.credentialsRef
  delete copy.outboundRecipients
  return copy as PluginAdapterInstanceInfo
}

/** Load a configured instance row or throw an actionable error. */
async function requireInstance(instanceId: string): Promise<AdapterInstanceRow> {
  const row = await getAdapterInstance(instanceId)
  if (!row) {
    throw new Error(`ctx.connectors: adapter instance ${instanceId} not found`)
  }
  return row
}

/**
 * Resolve a RUNNING, healthy adapter that declares every required
 * chat-management capability. Mirrors the `im.*` skills'
 * `resolveChatCapableAdapter`, minus the session-binding fallback — the
 * plugin always names the adapter explicitly.
 */
function resolveChatAdapter(adapterId: string, requiredCaps: readonly Capability[]) {
  const entry = getRunningAdapter(adapterId)
  if (!entry) {
    throw new Error(
      `ctx.connectors: adapter ${adapterId} is not running — reconnect it from Settings → Connections → Health.`
    )
  }
  const adapter = entry.adapter
  if (adapter.health().state !== "running") {
    throw new Error(
      `ctx.connectors: adapter ${adapterId} is not healthy (${adapter.health().state}).`
    )
  }
  const missing = requiredCaps.filter((cap) => !adapter.meta.capabilities.includes(cap))
  if (missing.length > 0) {
    throw new Error(
      `ctx.connectors: adapter ${adapterId} (${adapter.meta.type}) does not declare the required capabilities: ${missing.join(", ")}.`
    )
  }
  return { adapter, adapterId, platform: adapter.meta.type }
}

/**
 * Create the Connectors API for a plugin. See the permission model in the
 * file header: reads need `connectors:read`, outbound mutations need
 * `connectors:send`, instance management needs `connectors:manage`.
 */
export function createConnectorsAPI(pluginId: string): PluginConnectorsAPI {
  const personalContext = () =>
    personalSinkContextForRun(
      pluginExecutionContext(pluginId) ?? {},
      "plugin invocation unavailable"
    )
  const unknownWrite = async <T>(label: string, send: () => Promise<T>): Promise<T> => {
    const decision = await checkPersonalSink(
      personalContext(),
      { kind: "unknown", label },
      // Adapter callbacks may resolve files or transform operation arguments.
      // Their descriptors do not prove the exact content that would leave.
      undefined,
      { pluginId, label }
    )
    if (decision.outcome !== "allow")
      throw new Error("Personal content withheld: its person must disclose it before sharing")
    return send()
  }
  const api: PluginConnectorsAPI = {
    listManagementOperations: (adapterId) =>
      listConnectorManagementOperations(getBus().getAdapter(adapterId)),
    queryManagement: (adapterId, request) => {
      if (!connectorManagementIsRead(request.operation))
        throw new TypeError("Connector query cannot execute a mutation")
      return executeConnectorManagement(getBus().getAdapter(adapterId), request)
    },
    manage: (adapterId, request) =>
      connectorManagementIsRead(request.operation)
        ? executeConnectorManagement(getBus().getAdapter(adapterId), request)
        : unknownWrite("connector management", () =>
            executeConnectorManagement(getBus().getAdapter(adapterId), request)
          ),
    // ── reads ──────────────────────────────────────────────────────────────
    listAdapters: () => getBus().listAdapters().map(toInfo),
    getAdapter: (adapterId) => {
      const a = getBus().getAdapter(adapterId)
      return a ? toInfo(a) : null
    },
    getA2UICapabilityMatrix: (adapterId) => getBus().getAdapterA2UICapability(adapterId),
    getSkillCapabilities: (adapterId) => getBus().getAdapterSkillCapabilities(adapterId),
    listInstances: async () => (await listAdapterInstances()).map(toInstanceInfo),
    getInstance: async (id) => {
      const row = await getAdapterInstance(id)
      return row ? toInstanceInfo(row) : null
    },
    getRuntimeState: (adapterId) => getAdapterRuntimeStateSnapshot(adapterId),
    fetchHistory: async (adapterId, conversationKey, opts) => {
      const events = await getBus().fetchHistoryAll(adapterId, conversationKey, opts)
      const override = await readForResolution(conversationKey).catch(() => undefined)
      const session = await findSessionByConversationKey(conversationKey)
      const sessionId = override?.sessionId ?? session?.id
      if (!events.length) return events
      const bus = getBus()
      const hidden = await Promise.all(
        events.map(async (event) => {
          const stored =
            typeof bus.findStoredPlatformMessage === "function"
              ? await bus.findStoredPlatformMessage(event, event.messageId)
              : undefined
          if (!stored && !sessionId) return false
          return (
            (
              await preparePluginHistory(stored?.sessionId ?? sessionId, [
                stored ?? { ...event, id: event.messageId },
              ])
            ).withheldMessageIds.length > 0
          )
        })
      )
      return events.map((event, index) => {
        if (!hidden[index]) return event
        return {
          platform: event.platform,
          adapterId: event.adapterId,
          selfId: event.selfId,
          messageId: event.messageId,
          conversationRef: event.conversationRef,
          conversationKey: event.conversationKey,
          timestamp: event.timestamp,
          sender: { ...event.sender, displayName: undefined, avatarUrl: undefined },
          channel: { ...event.channel, name: undefined },
          mentions: { users: [], selfMentioned: false },
          segments: [{ type: "text" as const, text: "[Withheld: personal content]" }],
          plainText: "[Withheld: personal content]",
          raw: undefined,
        }
      })
    },
    onInbound: (handler) => getBus().subscribeInbound(handler),
    onCallback: (handler) => getBus().subscribeCallback(handler),
    listRunningAdapters: () => listRunningAdapters().map((e) => toInfo(e.adapter)),
    listEnabledInstances: async () =>
      (await listAdapterInstances()).filter((r) => r.enabled).map(toInstanceInfo),
    listInstancesByType: async (type) =>
      (await listAdapterInstances()).filter((r) => r.type === type).map(toInstanceInfo),
    findSessionByConversation: async (conversationKey) => {
      const session = await findSessionByConversationKey(conversationKey)
      return session ? toBoundSessionInfo(session) : null
    },
    listSessionsByConversation: async (conversationKey) =>
      (await listSessionsByConversationKey(conversationKey)).map(toBoundSessionInfo),
    listSiblingConversations: (conversationKey) => listSiblingConversations(conversationKey),
    getDispatchRules: async (instanceId) => (await requireInstance(instanceId)).dispatchRules ?? [],
    previewDispatchRules: async (instanceId, event) =>
      matchDispatchRule((await requireInstance(instanceId)).dispatchRules, event),
    previewAtGate: async (instanceId, event) => {
      const [instance, override] = await Promise.all([
        requireInstance(instanceId),
        readForResolution(event.conversationKey).catch(() => undefined),
      ])
      return shouldRespondToMessage(event, instance, override)
    },
    getOutboundJob: async (jobId) => {
      const row = await getDb().outboundQueue.get(jobId)
      return row ? toJobStatus(row) : null
    },
    waitForDelivery: async (jobId, opts) => {
      const timeoutMs = Math.min(Math.max(opts?.timeoutMs ?? 30_000, 100), 5 * 60_000)
      // Shared event-driven wait (Dexie liveQuery — no polling loop; also
      // used by the `action.connector.send` workflow node). The timeout
      // path resolves with the latest snapshot instead of rejecting so
      // callers can distinguish "still retrying" from "failed terminally"
      // by inspecting `status`.
      const row = await waitForOutboundTerminal(jobId, timeoutMs)
      if (!row) {
        throw new Error(`ctx.connectors.waitForDelivery: unknown job '${jobId}'`)
      }
      return toJobStatus(row)
    },

    // ── outbound mutations ───────────────────────────────────────────────────
    editMessage: (adapterId, messageId, patch) =>
      unknownWrite("connector message edit", () =>
        getBus().editOutbound(adapterId, messageId, patch)
      ),
    deleteMessage: (adapterId, messageId) => getBus().deleteOutbound(adapterId, messageId),
    deleteEphemeralCard: (adapterId, messageId) =>
      getBus().deleteEphemeralCard(adapterId, messageId),
    addReaction: (adapterId, messageId, emojiType) =>
      getBus().addReactionOutbound(adapterId, messageId, emojiType),
    removeReaction: (adapterId, messageId, reactionId) =>
      getBus().removeReactionOutbound(adapterId, messageId, reactionId),
    // Planned as a delivery to the target conversation that cannot wait (ADR-0239).
    forwardMessage: (adapterId, input) =>
      getConnectorDeliveryGateway().forward({
        adapterId,
        forward: input,
        source: "plugin",
        authorization: { kind: "plugin", pluginId },
        personalContext: personalContext(),
        auditFields: { pluginId },
      }),
    pinMessage: (adapterId, conversationKey, messageId) =>
      unknownWrite("connector message pin", () =>
        getBus().pinOutbound(adapterId, conversationKey, messageId)
      ),
    unpinMessage: (adapterId, messageId) => getBus().unpinOutbound(adapterId, messageId),
    // Planned as an immediate delivery to the people it notifies (ADR-0239).
    sendUrgent: (adapterId, messageId, userIds, via, opts) =>
      getConnectorDeliveryGateway().urgent({
        adapterId,
        messageId,
        userIds,
        ...(via ? { via } : {}),
        source: "plugin",
        personalContext: personalContext(),
        authorization: {
          kind: "plugin",
          pluginId,
          ...(opts?.botRunId ? { botRunId: opts.botRunId } : {}),
        },
        auditFields: { pluginId },
      }),
    getReadReceipt: (adapterId, messageId) => getBus().getReadReceiptOutbound(adapterId, messageId),
    setTyping: (adapterId, conversationKey, on) =>
      getBus().setTypingOutbound(adapterId, conversationKey, on),
    uploadFile: (adapterId, file) =>
      unknownWrite("connector upload", () => getBus().uploadFileOutbound(adapterId, file)),
    // Explicit intent uses the ordinary immediate planner. Legacy reference-only
    // streams return false under enforcement and are audited in shadow mode
    // so callers can fall back to governed delivery (ADR-0239).
    streamReply: async (adapterId, req) => {
      req = structuredClone(req)
      const finishWithNotice = async () => {
        const text = await personalDeliveryNotice(false)
        const decision = await checkPersonalSink(
          explicitHostPersonalSinkContext("fixed-notice"),
          { kind: "unknown", label: "connector stream fixed notice" },
          text,
          { adapterId }
        )
        if (decision.outcome === "allow") {
          await getBus().streamReplyOutbound(adapterId, { ...req, text })
          const adapter = getBus().getAdapter(adapterId)
          if (adapter?.cancelStreamReply && req.streamKey)
            await adapter.cancelStreamReply({
              conversationRef: req.conversationRef,
              streamKey: req.streamKey,
              sendOptions: req.sendOptions,
            })
          else
            // WeCom's authoritative empty final closes its accepted notice
            // preview with finish:true, without a newly protected text frame.
            await getBus().sendOutbound(adapterId, {
              conversationRef: req.conversationRef,
              segments: [],
              metadata: {
                idempotencyKey: `personal-stream-notice:${pluginId}:${req.streamKey ?? newIdempotencyKey()}`,
              },
            })
        }
      }
      if (req.sendOptions?.mode && req.sendOptions.mode !== "reply") {
        if (!req.conversationKey || typeof req.streamKey !== "string" || !req.streamKey)
          return false
        req.streamKey = explicitPluginStreamKey(pluginId, req.streamKey)
        try {
          const addressed = await pluginDestination(adapterId, req.conversationKey, {
            conversationRef: req.conversationRef,
            segments: [{ type: "markdown", md: req.text }],
            sendOptions: req.sendOptions,
            metadata: { idempotencyKey: req.streamKey, streamKey: req.streamKey },
          })
          const result = await getConnectorDeliveryGateway().sendNow(
            {
              adapterId,
              personalContext: personalContext(),
              conversationKey: req.conversationKey,
              deliveryMode: req.sendOptions.mode,
              segments: addressed.segments,
              idempotencyKey: req.streamKey,
              source: "plugin",
              authorization: { kind: "plugin", pluginId },
              auditKind: "delivery.stream_authorized",
              auditFields: { pluginId },
            },
            async () => ({
              ok: await getBus().streamReplyOutbound(adapterId, {
                ...req,
                conversationRef: addressed.conversationRef,
              }),
            })
          )
          if (!result.ok && result.error?.message.includes("private content"))
            await finishWithNotice()
          return result.ok
        } catch (error) {
          if (error instanceof PluginDestinationError || error instanceof ConnectorDeliveryPiiError)
            return false
          throw error
        }
      }
      return getConnectorDeliveryGateway().streamUnplanned(
        {
          adapterId,
          conversationRef: req.conversationRef,
          source: "plugin",
          ownerRef: `plugin:${pluginId}`,
          personalContext: personalContext(),
          payload: req,
          streamKey: req.streamKey,
          auditFields: { pluginId },
        },
        () => getBus().streamReplyOutbound(adapterId, req),
        finishWithNotice
      )
    },
    enqueueSend: async (adapterId, conversationKey, req, opts) => {
      const result = await getConnectorDeliveryGateway().enqueueAuthorized(
        {
          adapterId,
          conversationKey,
          // Sent where the host stored this conversation, never to a reference
          // of the plugin's own (ADR-0239).
          request: await pluginDestination(
            adapterId,
            conversationKey,
            namespaceExplicitPluginStream(pluginId, req),
            {},
            { queued: true }
          ),
          source: "plugin",
          personalContext: personalContext(),
          // Covered by one of this plugin's running, authorized tool calls, or
          // planned as the plugin's own unattended send, with the list of the
          // handler Bot run it names (ADR-0239).
          authorization: {
            kind: "plugin",
            pluginId,
            ...(opts?.botRunId ? { botRunId: opts.botRunId } : {}),
          },
          ...(opts?.nextAttemptAt !== undefined ? { nextAttemptAt: opts.nextAttemptAt } : {}),
        },
        { executionContext: personalContext() }
      )
      if (result.kind === "drafted") throw new ConnectorDeliveryHeldError(result.draft.id)
      const row = result.job
      return {
        jobId: row.id,
        adapterId: row.adapterId,
        conversationKey: row.conversationKey,
        status: row.status,
        nextAttemptAt: row.nextAttemptAt,
        idempotencyKey: row.idempotencyKey,
      }
    },

    // ── a2ui builder (pure) ──────────────────────────────────────────────────
    a2ui: createA2UIBuilder(),
    newIdempotencyKey: () => newIdempotencyKey(),

    // ── instance management ──────────────────────────────────────────────────
    // A stored escalation policy's urgent steps are a person's grant to notify
    // those people (ADR-0239): a plugin may keep or drop them, never add one.
    createInstance: async (input) => {
      assertNoAddedUrgentReach(undefined, input.defaultEscalation)
      return toInstanceInfo(await createAdapterInstance(input))
    },
    updateInstance: async (id, patch) => {
      // Dexie's `update` takes key paths (`"defaultEscalation.steps"`), which
      // would write a field past the checks on it: a plugin patches whole fields.
      const path = Object.keys(patch).find((key) => key.includes("."))
      if (path) {
        throw new TypeError(`updateInstance: "${path}" is a key path; patch whole fields instead`)
      }
      if ("defaultEscalation" in patch) {
        const stored = await getAdapterInstance(id)
        assertNoAddedUrgentReach(stored?.defaultEscalation, patch.defaultEscalation)
      }
      await updateAdapterInstance(id, patch)
    },
    setInstanceEnabled: (id, enabled) => updateAdapterInstance(id, { enabled }),
    deleteInstance: async (id) => {
      // Resolve the row so the keyring purge knows which accounts to drop;
      // an unknown id still runs the delete (idempotent no-op) so a plugin
      // retrying a removal never errors on the second attempt.
      const row = await getAdapterInstance(id)
      await removeAdapterInstance(row ?? { id })
    },
    setDispatchRules: async (instanceId, rules) => {
      await requireInstance(instanceId)
      await updateAdapterInstance(instanceId, { dispatchRules: rules })
    },
    bootstrapConversation: (input) =>
      bootstrapConversation({ ...input, source: `plugin:${pluginId}` }),

    // ── chat management (capability-gated, running adapter required) ────────
    createChat: async (adapterId, input) =>
      unknownWrite("connector chat creation", async () => {
        const resolved = resolveChatAdapter(adapterId, ["chat.create"])
        const fn = requireMethod(resolved, "createChat")
        return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
      }),
    updateChat: async (adapterId, input) =>
      unknownWrite("connector chat update", async () => {
        const resolved = resolveChatAdapter(adapterId, ["chat.update"])
        const fn = requireMethod(resolved, "updateChat")
        return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
      }),
    addChatMembers: async (adapterId, input) =>
      unknownWrite("connector chat membership", async () => {
        const resolved = resolveChatAdapter(adapterId, ["chat.members"])
        const fn = requireMethod(resolved, "addChatMembers")
        return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
      }),
    removeChatMembers: async (adapterId, input) =>
      unknownWrite("connector chat membership", async () => {
        const resolved = resolveChatAdapter(adapterId, ["chat.members"])
        const fn = requireMethod(resolved, "removeChatMembers")
        return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
      }),
    resolveContacts: async (adapterId, input) => {
      const resolved = resolveChatAdapter(adapterId, ["contact.resolve"])
      const fn = requireMethod(resolved, "resolveContacts")
      return withScopeCapture(adapterId, () => fn.call(resolved.adapter, input))
    },
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      listAdapters: "connectors:read",
      listManagementOperations: "connectors:read",
      queryManagement: "connectors:read",
      manage: "connectors:manage",
      getAdapter: "connectors:read",
      getA2UICapabilityMatrix: "connectors:read",
      getSkillCapabilities: "connectors:read",
      listInstances: "connectors:read",
      getInstance: "connectors:read",
      getRuntimeState: "connectors:read",
      fetchHistory: "connectors:read",
      onInbound: "connectors:read",
      onCallback: "connectors:read",
      listRunningAdapters: "connectors:read",
      listEnabledInstances: "connectors:read",
      listInstancesByType: "connectors:read",
      findSessionByConversation: "connectors:read",
      listSessionsByConversation: "connectors:read",
      listSiblingConversations: "connectors:read",
      getDispatchRules: "connectors:read",
      previewDispatchRules: "connectors:read",
      previewAtGate: "connectors:read",
      getOutboundJob: "connectors:read",
      waitForDelivery: "connectors:read",
      getReadReceipt: "connectors:read",
      editMessage: "connectors:send",
      deleteMessage: "connectors:send",
      deleteEphemeralCard: "connectors:send",
      addReaction: "connectors:send",
      removeReaction: "connectors:send",
      forwardMessage: "connectors:send",
      pinMessage: "connectors:send",
      unpinMessage: "connectors:send",
      sendUrgent: "connectors:send",
      setTyping: "connectors:send",
      uploadFile: "connectors:send",
      streamReply: "connectors:send",
      enqueueSend: "connectors:send",
      createInstance: "connectors:manage",
      updateInstance: "connectors:manage",
      setInstanceEnabled: "connectors:manage",
      deleteInstance: "connectors:manage",
      setDispatchRules: "connectors:manage",
      bootstrapConversation: "connectors:manage",
      createChat: "connectors:manage",
      updateChat: "connectors:manage",
      addChatMembers: "connectors:manage",
      removeChatMembers: "connectors:manage",
      resolveContacts: "connectors:manage",
    },
    {
      // Pure, ungated helper (mints a client-side idempotency key). The `a2ui`
      // builder is a non-function property and passes through unchanged.
      unguarded: ["newIdempotencyKey"],
      egressMethods: [
        "queryManagement",
        "manage",
        "fetchHistory",
        "resolveContacts",
        "getReadReceipt",
        "deleteMessage",
        "deleteEphemeralCard",
        "addReaction",
        "removeReaction",
        "unpinMessage",
        "setTyping",
        "createInstance",
        "updateInstance",
        "setInstanceEnabled",
      ],
    }
  )
}

function explicitPluginStreamKey(pluginId: string, streamKey: string): string {
  return `plugin-stream:${JSON.stringify([pluginId, streamKey])}`
}

function namespaceExplicitPluginStream(
  pluginId: string,
  request: OutboundRequest
): OutboundRequest {
  if (
    !request.sendOptions?.mode ||
    request.sendOptions.mode === "reply" ||
    !request.metadata.streamKey
  )
    return request
  if (typeof request.metadata.streamKey !== "string")
    throw new TypeError("Invalid connector stream key")
  return {
    ...request,
    metadata: {
      ...request.metadata,
      streamKey: explicitPluginStreamKey(pluginId, request.metadata.streamKey),
    },
  }
}
