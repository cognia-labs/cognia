/**
 * What a mirrored client does once its Host answered a plugin toggle it
 * queued (ADR-0258, mirror clause `host-answer-wins`).
 *
 * `setPluginEnabledForHost` writes the flag into the mirror optimistically and
 * queues `plugin_set_enabled`; until the Host answers, the toggle is reported
 * as queued, not applied. The answer then decides what the row shows:
 *
 * - **Applied:** the Host's own row may differ from the optimistic one (its
 *   status, a dependency it enabled alongside), so one coalesced `plugins`
 *   pull a moment later brings it.
 * - **Refused by the Host:** nothing changed upstream, so a delta pull would
 *   never correct the optimistic flag. The `plugins` cursor is rewound and the
 *   table read again from the Host. The queue retries the job on its own
 *   schedule; the row shows the Host's state meanwhile.
 * - **Not delivered** (network, timeout, a carrier without a code): the
 *   Host has not answered, so the toggle stays queued and the row unchanged.
 */

/** Delay before the follow-up pull, so a burst of toggles shares one. */
export const PLUGIN_TOGGLE_FOLLOW_UP_SYNC_MS = 1_500

export type PluginToggleAnswer = { ok: true } | { ok: false; error: unknown }

export interface SettlePluginToggleDeps {
  rewind: () => void
  pull: () => Promise<unknown>
  schedule: (run: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
}

let pending: unknown = null

async function defaultDeps(): Promise<SettlePluginToggleDeps> {
  const { rewindSyncTable, runSyncDown } = await import("@/lib/sync/companion-sync")
  return {
    rewind: () => rewindSyncTable("plugins"),
    pull: () => runSyncDown({ only: ["plugins"] }),
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

const UNDELIVERED_CODES: ReadonlySet<string> = new Set(["network", "timeout"])

/**
 * Whether `error` is the Host's answer rather than a failure to reach it.
 * Transport errors that came back from the Host carry a code; only the
 * network and timeout codes mean it never answered.
 */
export function isHostRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && !UNDELIVERED_CODES.has(code)
}

export async function settleMirroredPluginToggle(
  answer: PluginToggleAnswer,
  deps?: SettlePluginToggleDeps
): Promise<void> {
  if (!answer.ok && !isHostRefusal(answer.error)) return
  const resolved = deps ?? (await defaultDeps())
  if (pending !== null) {
    resolved.cancel(pending)
    pending = null
  }
  if (!answer.ok) resolved.rewind()
  pending = resolved.schedule(() => {
    pending = null
    void resolved.pull().catch(() => undefined)
  }, PLUGIN_TOGGLE_FOLLOW_UP_SYNC_MS)
}

/** @internal */
export function __resetPluginToggleSettlementForTests(): void {
  pending = null
}
