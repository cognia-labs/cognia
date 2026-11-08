/**
 * Lark's contribution to the vendor-neutral IM framework (ADR-0250 §14,
 * `lib/connectors/vendor-contribution.ts`). Listed in `../_vendors.ts`.
 *
 * Every framework file that reads the seam loads this module, so it imports
 * only light constants eagerly; each hook loads the code it needs.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ConnectorVendorContribution } from "@/lib/connectors/vendor-contribution"
import { LARK_CAPS } from "./capability"

/** A Lark direct chat, including a topic opened inside one. */
function isPrivateConversation(event: NormalizedInboundEvent): boolean {
  return (
    event.channel.kind === "private" ||
    event.conversationAddress?.scopeKind === "private" ||
    event.conversationRef.channelKind === "private" ||
    event.conversationRef.scopeKind === "private"
  )
}

/** The run state a result card shows for a projected run's terminal status. */
function cardStatus(status: string): "done" | "interrupted" | "error" {
  return status === "completed" ? "done" : status === "cancelled" ? "interrupted" : "error"
}

export const larkContribution: ConnectorVendorContribution = {
  platform: "lark",
  capabilities: LARK_CAPS,
  builtInSkills: {
    families: ["lark.base", "lark.calendar", "lark.doc", "lark.sheets", "lark.task", "lark.wiki"],
    load: () => import("./builtin-skills"),
  },
  buildAdapter: async (row) => (await import("./build")).buildLarkAdapter(row),
  loadIdentityProbe: async () => (await import("./whoami")).probeBotIdentity,
  completeOAuth: async (code, state) => {
    const { handleLarkOAuth } = await import("@/lib/auth-providers/feishu/oauth-handler")
    await handleLarkOAuth(code, { state })
  },
  passiveTransport: {
    // Only webhook mode waits for pushes; long-connection keeps its own socket health.
    applies: (row) => (row.settings as { transport?: string } | undefined)?.transport === "webhook",
    ping: async (row) => (await import("./health")).pingLark(row),
    failureReason: "lark_ping_failed",
  },
  avatar: {
    hosts: [
      "feishucdn.com",
      "larksuitecdn.com",
      "byteimg.com",
      "feishu.cn",
      "sf1-ttcdn-tos.pstatp.com",
    ],
    resolve: async (context) => (await import("./avatar")).resolveLarkAvatar(context),
  },
  // The chat-surface retry sweep and the bind-request expiry sweep. Without a
  // runtime-wide driver a surface that failed once stayed failed until a
  // restart (only adapter start, `bot.added` and the settings button retried
  // it), and an expired bind code stayed `pending`. They start once the
  // schedule module loads; disposing before then cancels the start.
  startRuntimeServices: () => {
    let disposed = false
    let handles: Array<{ dispose(): void }> = []
    void import("./surface-schedule")
      .then(({ startBindRequestExpirySweep, startLarkSurfaceSweep }) => {
        if (disposed) return
        handles = [startLarkSurfaceSweep(), startBindRequestExpirySweep()]
      })
      .catch((error: unknown) => {
        console.warn("[lark] runtime sweeps failed to start", error)
      })
    return [
      {
        dispose() {
          disposed = true
          for (const handle of handles) handle.dispose()
          handles = []
        },
      },
    ]
  },
  conversations: {
    isPrivate: isPrivateConversation,
    // A private topic, or the conversation the bot's menu opened, lists the
    // chat's sessions rather than one conversation key's.
    chatScopedSessions: (event) =>
      isPrivateConversation(event) &&
      (event.conversationRef.replyInThread === true ||
        event.channelData?.larkMenuConversation === true),
    deliveryProbe: (event) => event.channel.kind === "group",
  },
  commands: {
    renderReply: async (command, text, outcome) =>
      (await import("./command-cards")).buildLarkCommandReply(command, text, outcome),
    // Feishu draws the status view as tiles.
    renderStatus: async (view) => (await import("./command-cards")).buildLarkStatusCard(view),
  },
  closedApprovalSegment: async (state, detail) =>
    (await import("./approval-card")).buildLarkClosedApprovalSegment(state, detail),
  reply: {
    turnLocale: async (text, language) =>
      (await import("./card-kit")).larkReplyLocale(text, language),
    titleFromMessage: true,
    // A completed answer ships as a Card 2.0 result card (header state, the
    // `> 回复：…` quote when native reply-quoting is off, elapsed / initiator /
    // run-link footer). A card survives the serializer only as its request's
    // sole segment, so the list is grouped: contiguous non-card runs keep
    // the combined body, each card goes out as its own interactive message.
    finalGroups: async (segments, context) => {
      const [
        { splitLarkCardSegments, withLarkResultCard },
        { buildRunDetailsUrl, resolveWebEntryBase },
      ] = await Promise.all([import("./result-card"), import("./entry/deep-links")])
      const carded = withLarkResultCard(segments, {
        presentation: context.presentationAdapter?.settings?.cardPresentation,
        status: context.status,
        quote: context.quote,
        elapsedMs: context.elapsedMs,
        // Naming the asker tells a group who the answer is for; in a private
        // chat it only mentions the reader to themselves.
        initiatorOpenId:
          !context.privateChat && /^ou_[A-Za-z0-9]+$/.test(context.initiator)
            ? context.initiator
            : undefined,
        locale: context.locale,
        detailsUrl:
          buildRunDetailsUrl(context.runId, resolveWebEntryBase(context.receivingAdapter)) ??
          undefined,
        fallbackAnswer: context.fallbackAnswer,
      })
      const groups = splitLarkCardSegments(carded)
      // An empty list keeps the default single enqueue.
      return groups.length > 0 ? groups : undefined
    },
  },
  principals: {
    resolve: async (input) => (await import("./principal/resolve")).resolveLarkPrincipal(input),
    resolveInbound: async (input) =>
      (await import("./principal/inbound")).resolveLarkInboundPrincipal(input),
    handleUnresolved: async (event, adapterRow, resolution, inboundJobId) =>
      (await import("./principal/unbound")).handleUnresolvedPrincipal(
        event,
        adapterRow,
        resolution,
        inboundJobId
      ),
  },
  // A Feishu sign-in records its subject on the person's principals; a
  // sign-out or takeover unlinks the ones the binding admitted.
  principalLinks: {
    attachSignIn: async (input) =>
      (await import("./principal/login-link")).attachSignInToFeishuPrincipals(input),
    unlinkSelfBound: async (input) =>
      (await import("./principal/login-link")).unlinkSelfBoundPrincipals(input),
  },
  runPresentation: {
    // The milestone is a result card (state header, elapsed / details footer)
    // rather than a bare markdown bubble. The projected snapshot is already
    // PII-safe, so its timeline and run link go straight into the card body.
    milestone: async (snapshot, { adapter, timeline }) => {
      const [{ buildLarkResultCardSegment }, { resolveWebEntryBase }] = await Promise.all([
        import("./result-card"),
        import("./entry/deep-links"),
      ])
      const base = resolveWebEntryBase()
      return buildLarkResultCardSegment({
        locale: snapshot.locale,
        presentation: adapter?.settings?.cardPresentation,
        answer: timeline,
        status: cardStatus(snapshot.status),
        elapsedMs: snapshot.elapsedMs,
        ...(base && snapshot.detailsUrl ? { detailsUrl: `${base}${snapshot.detailsUrl}` } : {}),
      })
    },
    fallback: async (snapshot, adapter) => {
      const [{ buildLarkRunFallbackSegment }, { resolveWebEntryBase }] = await Promise.all([
        import("./run-presentation/driver"),
        import("./entry/deep-links"),
      ])
      return buildLarkRunFallbackSegment(
        snapshot,
        resolveWebEntryBase(adapter),
        adapter?.settings?.cardPresentation
      )
    },
  },
}
