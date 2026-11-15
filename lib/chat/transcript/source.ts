import type { Page } from "@/lib/tauri/companion-paging"
import type {
  SessionTimelinePage,
  SessionTimelineRequest,
  SessionTurnMessagesPage,
  SessionTurnMessagesRequest,
  TranscriptCapabilitiesV1,
} from "@cognia/agent-config-types"
import {
  TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT,
  TRANSCRIPT_DETAIL_PAGE_MAX,
  TRANSCRIPT_PROTOCOL_VERSION,
  TRANSCRIPT_SUMMARY_BYTE_LIMIT,
  TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
  TRANSCRIPT_TIMELINE_PAGE_MAX,
} from "@cognia/agent-config-types"
import type { Transport } from "@/lib/tauri/transport-types"

import {
  isTranscriptLiveFrame,
  TRANSCRIPT_LIVE_TOPIC,
  type TranscriptLiveFrame,
} from "./live-frames"

export interface TranscriptSource {
  capabilities(): Promise<TranscriptCapabilitiesV1>
  timeline(request: SessionTimelineRequest): Promise<SessionTimelinePage>
  turnMessages(request: SessionTurnMessagesRequest): Promise<SessionTurnMessagesPage>
  subscribeRevision?(sessionId: string, listener: (revision: number) => void): () => void
  /** A member agent's in-flight reply, as the Host relays it (`live-frames.ts`). */
  subscribeLive?(sessionId: string, listener: (frame: TranscriptLiveFrame) => void): () => void
}

export function transcriptCapabilitiesV1(): TranscriptCapabilitiesV1 {
  return {
    version: TRANSCRIPT_PROTOCOL_VERSION,
    maxTimelinePageSize: TRANSCRIPT_TIMELINE_PAGE_MAX,
    maxTurnMessagePageSize: TRANSCRIPT_DETAIL_PAGE_MAX,
    maxTurnMessagePageBytes: TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT,
    maxSummaryBytes: TRANSCRIPT_SUMMARY_BYTE_LIMIT,
    maxSummaryMediaRefs: TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
    mediaVariants: ["thumbnail", "canonical"],
  }
}

/** Transcript adapter for Companion/RTC transports. */
export interface RemoteTranscriptSourceOptions {
  /**
   * Tell the source the transport was replaced, so a live revision
   * subscription moves to the new one. Pairs with a `transport` resolver.
   */
  onTransportChange?: (handler: () => void) => () => void
}

export function createRemoteTranscriptSource(
  transport: Transport | (() => Transport),
  options: RemoteTranscriptSourceOptions = {}
): TranscriptSource {
  // Resolved per call, not captured. Both callers build their source at module
  // load, when a browser that pairs later still holds the web stub: every read
  // then failed with `no_host_transport` ("Retry transcript"), and the revision
  // subscription listened to the stub, so a reply kept on the host never showed
  // up until a reload rebuilt the module.
  const current = typeof transport === "function" ? transport : () => transport
  // The capability answer belongs to the transport (host) that gave it.
  const capabilityState = new WeakMap<Transport, TranscriptCapabilitiesV1>()

  const capabilities = async (): Promise<TranscriptCapabilitiesV1> => {
    const target = current()
    const known = capabilityState.get(target)
    if (known) return known
    const answer = await target.call<TranscriptCapabilitiesV1>("transcript_capabilities", {})
    capabilityState.set(target, answer)
    return answer
  }

  return {
    capabilities,
    subscribeRevision(sessionId, listener) {
      const listen = () =>
        current().subscribe<{ sessionId?: string; revision?: number }>(
          "transcript://revision",
          (event) => {
            if (event.sessionId !== sessionId || typeof event.revision !== "number") return
            listener(event.revision)
          }
        )
      let unsubscribe = listen()
      const stopFollowing = options.onTransportChange?.(() => {
        unsubscribe()
        unsubscribe = listen()
      })
      return () => {
        stopFollowing?.()
        unsubscribe()
      }
    },
    subscribeLive(sessionId, listener) {
      // Opt-in by name (the Host's catalog has it off by default); a Host
      // without the channel refuses the name and simply never sends one.
      const listen = () =>
        current().subscribe<unknown>(TRANSCRIPT_LIVE_TOPIC, (frame) => {
          if (!isTranscriptLiveFrame(frame) || frame.sessionId !== sessionId) return
          listener(frame)
        })
      let unsubscribe = listen()
      const stopFollowing = options.onTransportChange?.(() => {
        unsubscribe()
        unsubscribe = listen()
      })
      return () => {
        stopFollowing?.()
        unsubscribe()
      }
    },
    async timeline(request) {
      return current().call<SessionTimelinePage>("session_timeline", {
        session_id: request.sessionId,
        direction: request.direction,
        cursor: request.cursor,
        limit: request.limit,
      })
    },
    async turnMessages(request) {
      // The wire pages by pageSize/pageToken and answers the page envelope
      // (ADR-0175 B3). The transcript protocol keeps its own cursor words,
      // so the token rides in `nextCursor` and comes back as `cursor`.
      const page = await current().call<
        Page<SessionTurnMessagesPage["messages"][number]> &
          Pick<
            SessionTurnMessagesPage,
            "revision" | "detailRevision" | "total" | "approximateBytes"
          >
      >("session_turn_messages", {
        session_id: request.sessionId,
        turn_key: request.turnKey,
        revision: request.revision,
        detail_revision: request.detailRevision,
        pageSize: request.limit,
        pageToken: request.cursor,
      })
      return {
        messages: page.items,
        revision: page.revision,
        detailRevision: page.detailRevision,
        total: page.total,
        approximateBytes: page.approximateBytes,
        ...(page.nextPageToken ? { nextCursor: page.nextPageToken } : {}),
        hasMore: Boolean(page.nextPageToken),
      }
    },
  }
}
