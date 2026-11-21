"use client"

/**
 * A paired client's view of one run's step events (WF-23).
 *
 * Companion sync carries a run's summary row to a paired client, never its
 * step events: those stay on the Host that ran it. A run detail on a phone
 * read only its local event table, so it showed a run with no steps. This
 * hook reads them from the Host on demand through `workflow_run_events_list`
 * (`lib/workflow/remote/host-commands.ts`), page by page in sequence order,
 * and keeps polling for new events until the run is over.
 *
 * The Host's page also carries the run row as the Host holds it, so a run
 * the client's mirror has not synced yet (a preview it just started) still
 * opens, and a run the Host does not have is reported as `null`.
 */

import { useEffect, useState } from "react"

import { transport } from "@/lib/tauri/transport-instance"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

export interface HostRunEventsPage {
  run: WorkflowRunRow | null
  events: WorkflowRunEventRow[]
  nextSequence: number
  terminal: boolean
}

export interface HostRunEventsState {
  /** `undefined` until the Host answered once; `null` when it has no such run. */
  run: WorkflowRunRow | null | undefined
  events: WorkflowRunEventRow[]
  /** The last read failed; reads keep retrying. */
  error: string | null
}

export interface UseHostRunEventsOptions {
  /** Wait between reads while the run is live. */
  pollMs?: number
  /** Events per page. */
  pageSize?: number
  /**
   * The Host read; injected by tests. Pass a stable function (module level
   * or memoised): a new one restarts the read from the first event.
   */
  fetchPage?: (request: {
    runId: string
    afterSequence: number
    limit: number
  }) => Promise<HostRunEventsPage>
}

const DEFAULT_POLL_MS = 2_000
const DEFAULT_PAGE_SIZE = 200

const fetchFromHost: NonNullable<UseHostRunEventsOptions["fetchPage"]> = async (request) =>
  (await transport.call("workflow_run_events_list", request)) as HostRunEventsPage

const IDLE: HostRunEventsState = { run: undefined, events: [], error: null }

export function useHostRunEvents(
  runId: string,
  enabled: boolean,
  options: UseHostRunEventsOptions = {}
): HostRunEventsState {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const fetchPage = options.fetchPage ?? fetchFromHost
  const [state, setState] = useState<{ key: string; value: HostRunEventsState }>({
    key: "",
    value: IDLE,
  })
  const key = enabled ? runId : ""

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let afterSequence = 0
    let events: WorkflowRunEventRow[] = []

    const publish = (value: HostRunEventsState) => {
      if (!cancelled) setState({ key: runId, value })
    }
    const read = async (): Promise<void> => {
      let wait = pollMs
      try {
        const page = await fetchPage({ runId, afterSequence, limit: pageSize })
        if (cancelled) return
        // Sequences only grow; a page that repeats one (a retried read that
        // raced a live append) adds nothing twice.
        const fresh = page.events.filter((event) => (event.sequence ?? 0) > afterSequence)
        if (fresh.length > 0) events = [...events, ...fresh]
        afterSequence = Math.max(afterSequence, page.nextSequence)
        publish({ run: page.run, events, error: null })
        if (page.run === null || page.terminal) return
        // A full page means more is already waiting: read it now.
        if (page.events.length >= pageSize) wait = 0
      } catch (error) {
        if (cancelled) return
        setState((current) => ({
          key: runId,
          value: {
            ...(current.key === runId ? current.value : IDLE),
            error: error instanceof Error ? error.message : String(error),
          },
        }))
        // Back off while the Host is unreachable.
        wait = pollMs * 2
      }
      if (!cancelled) timer = setTimeout(() => void read(), wait)
    }
    void read()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [enabled, runId, pollMs, pageSize, fetchPage])

  // A state left from another run (or from before the read was enabled) is
  // never shown for this one.
  return state.key === key && enabled ? state.value : IDLE
}
