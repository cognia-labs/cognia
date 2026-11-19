"use client"

// ADR-0020 W3 — bridge the Rust `automation:kill-switch` event to two
// renderer-side concerns the Rust path can't reach itself:
//
//   1. Drop every chat-side per-session computer-use grant
//      (`clearAllSessionGrants`) so a returning operator doesn't
//      inherit "always allow this session" approvals the previous user
//      accumulated. The Rust ConsentBroker already clears its own
//      grants in the shortcut dispatch — this mirrors that on the chat
//      modal side so both gates are honestly reset.
//   2. Surface a sonner toast so the operator gets visible feedback
//      when the global shortcut (Ctrl+Shift+Alt+K or whatever they
//      bound) fires. Without this, a chord press would be silent and
//      operators wouldn't know whether their key combo actually landed.
//
// Mounted once at the root layout; the listener auto-unsubscribes on
// unmount. No-op in web mode (Tauri events never fire).

import { useEffect } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

export function ComputerUseKillSwitchInitializer() {
  const t = useTranslations("automation.executionStop")
  useEffect(() => {
    if (!isTauri()) return
    const unlisteners: (() => void)[] = []
    let cancelled = false
    void (async () => {
      const [{ listen }, { clearAllSessionGrants }] = await Promise.all([
        import("@tauri-apps/api/event"),
        import("@/lib/plugin/security/computer-use-session-grants"),
      ])
      const notify = (settled: boolean) =>
        toast.warning(t(settled ? "stopped" : "stopping"), {
          id: "automation-execution-stop",
          description: t(settled ? "stoppedHelp" : "stoppingHelp"),
        })
      let latestEpoch = -1
      let latestSettled = false
      const subscribe = async (name: string, clear: boolean) => {
        const unlisten = await listen<{ epoch?: number; settled?: boolean }>(name, (event) => {
          if (clear) clearAllSessionGrants()
          const epoch = event?.payload?.epoch
          if (epoch !== undefined) {
            if (epoch < latestEpoch) return
            if (epoch > latestEpoch) latestSettled = false
            latestEpoch = epoch
            latestSettled ||= event.payload.settled === true
            notify(latestSettled)
          } else {
            notify(event?.payload?.settled === true)
          }
        })
        if (cancelled) safeUnlisten(unlisten)
        else unlisteners.push(unlisten)
      }
      await Promise.all([
        subscribe("automation:kill-switch", true),
        subscribe("automation:execution-settled", false),
      ])
    })().catch(() => {})
    return () => {
      cancelled = true
      unlisteners.forEach(safeUnlisten)
    }
  }, [t])

  return null
}

export default ComputerUseKillSwitchInitializer
