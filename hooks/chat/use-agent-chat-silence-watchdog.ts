"use client"

import { createSilenceWatchdog, type SilenceWatchdog } from "@/lib/chat/silence-watchdog"
import { useChatStore } from "@/stores/chat"
import { createDiagnostic } from "@cognia/diagnostics"
import { useCallback, useEffect, useRef } from "react"

/**
 * Turn-silence watchdog (see `lib/chat/silence-watchdog`). Armed once a send is
 * dispatched, fed by every inbound frame, and disarmed by a store watcher when
 * the session leaves an active status. It raises a persistent `turnSilent`
 * warning and nothing else — it never ends the turn, because a long tool call
 * is indistinguishable from a dropped one at this layer.
 */
export function useAgentChatSilenceWatchdog() {
  const silenceWatchdogRef = useRef<SilenceWatchdog | null>(null)
  // Created on demand rather than in the render body, because the effect below
  // disposes and clears the ref on cleanup. StrictMode replays mount → cleanup
  // → mount with NO re-render in between, so a render-body lazy init left the
  // second mount reading `null`, returning early, and installing no
  // subscription — the watchdog was inert for the whole of development. Making
  // the effect the thing that guarantees an instance keeps the two in step:
  // whatever is subscribed is what `arm` / `notice` reach.
  const ensureSilenceWatchdog = useCallback((): SilenceWatchdog => {
    const existing = silenceWatchdogRef.current
    if (existing) return existing
    const created = createSilenceWatchdog({
      onSilent: (sessionId, silentForMs) => {
        const session = useChatStore.getState().sessions[sessionId]
        // Never overwrite a real failure with "we heard nothing": a diagnostic
        // already on the session is strictly more informative than this one.
        if (session?.errorDiagnostic) return
        // And never warn about a turn that is not running. The store watcher
        // disarms on every settle, but it can only disarm what is armed — so
        // this is the backstop for any path that settles a session the clock
        // has not been told about yet. A card offering "Interrupt" on an idle
        // conversation is worse than no card.
        if (session?.status !== "streaming" && session?.status !== "awaiting_approval") return
        useChatStore.getState().setSessionDiagnostic(
          sessionId,
          createDiagnostic("turnSilent", {
            source: "chat",
            meta: { sessionId, extra: { silentForMs } },
          })
        )
      },
      onRecovered: (sessionId) => {
        // Clear only our own warning. Anything else on the session came from a
        // producer that knows more than the clock does.
        const current = useChatStore.getState().sessions[sessionId]?.errorDiagnostic
        if (current?.code === "turnSilent") {
          useChatStore.getState().setSessionDiagnostic(sessionId, null)
        }
      },
    })
    silenceWatchdogRef.current = created
    return created
  }, [])

  useEffect(() => {
    const watchdog = ensureSilenceWatchdog()
    // Same shape as the execution-broker lease watcher: one subscription
    // covers every settle path (session_ended, error, interrupt, external-agent
    // completion) instead of a disarm call per exit.
    //
    // Scoped to the ARMED sessions, not to every open one. This store writes
    // once per streaming delta, so an `Object.entries(state.sessions)` sweep
    // here ran the full session list thousands of times a turn to answer a
    // question about (normally) one of them. `state.sessions` identity is the
    // cheap first cut — most writes are composer/projection fields that leave
    // it alone — and `watchdog.armed()` is the second.
    //
    // `previous` is optional on purpose. Zustand always passes it, but it is
    // only ever an OPTIMISATION here — the armed scan below is correct on its
    // own — so a caller that notifies with just the new state (a test double,
    // a wrapper store) must still get the disarm, not a TypeError inside a
    // subscription every other producer shares.
    const unsubscribe = useChatStore.subscribe((state, previous?: typeof state) => {
      if (previous && state.sessions === previous.sessions) return
      for (const sessionId of watchdog.armed()) {
        const session = state.sessions[sessionId]
        // A closed pane drops its slice entirely; that is a settle too, and the
        // old sweep could not see it because it only walked what still existed.
        if (
          !session ||
          (session.status !== "streaming" && session.status !== "awaiting_approval")
        ) {
          watchdog.disarm(sessionId)
        }
      }
    })
    return () => {
      unsubscribe()
      watchdog.dispose()
      if (silenceWatchdogRef.current === watchdog) silenceWatchdogRef.current = null
    }
  }, [ensureSilenceWatchdog])
  return { silenceWatchdogRef }
}
