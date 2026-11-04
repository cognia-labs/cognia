"use client"

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import {
  OpenCodeV2Auth,
  type OpenCodeAuthSnapshot,
  type OpenCodeAuthClient,
} from "@cognia/agent-opencode/v2-auth"

const EMPTY: OpenCodeAuthSnapshot = { integrations: [], loading: false, phase: "idle" }
const emptySnapshot = () => EMPTY
const emptySubscribe = () => () => {}

/** Bind temporary login work to the selected Agent's live V2 client. */
export function useOpencodeAuth(agentId: string, connected: boolean) {
  const request = useMemo(() => ({ agentId, connected }), [agentId, connected])
  const [binding, setBinding] = useState<{ request: typeof request; controller: OpenCodeV2Auth }>()
  const [failedRequest, setFailedRequest] = useState<typeof request>()
  const controller = binding?.request === request ? binding.controller : undefined
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? emptySubscribe,
    controller?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  )

  useEffect(() => {
    if (!connected) return
    let alive = true
    let owned: OpenCodeV2Auth | undefined
    let unsubscribe: (() => void) | undefined
    let refresh: (() => void) | undefined
    void Promise.all([
      import("@/lib/ai/agent/external/manager"),
      import("@cognia/agent-opencode/v2-client"),
    ])
      .then(([{ getExternalAgentManager }, { openCodeV2Extension }]) => {
        if (!alive) return
        const manager = getExternalAgentManager()
        let client: OpenCodeAuthClient | undefined
        let directory: string | undefined
        const bind = () => {
          if (!alive) return
          const adapter = manager.getAdapterExtension(agentId, openCodeV2Extension)
          let next: typeof client
          try {
            next = adapter?.getAuthClient()
          } catch {
            next = undefined
          }
          const cwd = manager.getAgent(agentId)?.config.process?.cwd
          if (next === client && cwd === directory) return
          owned?.dispose()
          owned = undefined
          client = next
          directory = cwd
          if (!client) {
            setBinding(undefined)
            return
          }
          owned = new OpenCodeV2Auth(client, directory)
          setBinding({ request, controller: owned })
          void owned.refresh()
        }
        bind()
        unsubscribe = manager.addLifecycleListener((event) => {
          if (event.agentId === agentId) bind()
        })
        refresh = () => {
          bind()
          void owned?.refresh()
        }
        window.addEventListener("focus", refresh)
      })
      .catch(() => {
        if (alive) setFailedRequest(request)
      })
    return () => {
      alive = false
      unsubscribe?.()
      if (refresh) window.removeEventListener("focus", refresh)
      owned?.dispose()
    }
  }, [agentId, connected, request])

  return { controller, snapshot, available: !!controller, failed: failedRequest === request }
}
