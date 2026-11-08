"use client"

/**
 * Wait for the next command in a live tab to finish, and report what it printed.
 *
 * Shared by the two callers that drive a dock tab programmatically and hand the
 * result to an agent or a workflow: `runInDockTab` (write, then wait) and the
 * Dock `wait_for_exit` tool (wait for whatever is already running). Both used
 * to answer `output` with the command line from the store's recent-commands
 * ring, which is metadata, not output: a downstream step reading stdout got
 * the text it had just sent.
 *
 * The output is read from the byte stream through `BaseTerminalSession.tapData`,
 * which observes without draining the early-data buffer the dock's xterm will
 * replay on mount, and is sliced on the OSC 633 `C`/`D` sequences by
 * `extractMarkedCommandOutput`. A wait that starts after the command did (the
 * `wait_for_exit` case) sees only what was printed from then on — the stream
 * cannot be read backwards — and says so through `fromStart: false`.
 */

import type { BaseTerminalSession } from "./base-session"
import { extractMarkedCommandOutput, hasCommandEndMarker } from "./command-output"

/** How much decoded text a single wait keeps; the newest text wins. */
export const MAX_CAPTURED_CHARS = 512 * 1024

/**
 * How long to wait for the chunk carrying the `D` sequence after the
 * integration event. The PTY reader emits a chunk's integration events before
 * the chunk itself (`session.rs:pty_reader_loop`), so the final bytes normally
 * follow at once; this bounds a transport that dropped or reordered them.
 */
export const END_CHUNK_GRACE_MS = 150

export type CommandEndOutcome =
  | {
      kind: "ended"
      exitCode: number | null
      output: string
      /** The head of the output was dropped to stay within {@link MAX_CAPTURED_CHARS}. */
      truncated: boolean
    }
  | { kind: "timeout" }
  | { kind: "exited" }

export interface AwaitCommandEndOptions {
  timeoutMs: number
  /**
   * Runs after every listener is attached, so a write it performs cannot
   * produce output or a `command_end` the wait misses.
   */
  start?: () => void
}

export function awaitCommandEnd(
  session: Pick<BaseTerminalSession, "tapData" | "onIntegration" | "onExit">,
  options: AwaitCommandEndOptions
): Promise<CommandEndOutcome> {
  return new Promise<CommandEndOutcome>((resolve) => {
    const decoder = new TextDecoder()
    let raw = ""
    let truncated = false
    let ended: { exitCode: number | null } | null = null
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const cleanups: Array<() => void> = []
    const finish = (outcome: CommandEndOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (graceTimer) clearTimeout(graceTimer)
      for (const cleanup of cleanups) {
        try {
          cleanup()
        } catch {
          /* listener already gone */
        }
      }
      resolve(outcome)
    }
    const finishEnded = () => {
      if (!ended) return
      raw += decoder.decode()
      finish({
        kind: "ended",
        exitCode: ended.exitCode,
        output: extractMarkedCommandOutput(raw),
        truncated,
      })
    }

    const timeoutTimer = setTimeout(() => finish({ kind: "timeout" }), options.timeoutMs)

    cleanups.push(
      session.tapData((bytes) => {
        raw += decoder.decode(bytes, { stream: true })
        if (raw.length > MAX_CAPTURED_CHARS) {
          raw = raw.slice(raw.length - MAX_CAPTURED_CHARS)
          truncated = true
        }
        if (ended && hasCommandEndMarker(raw)) finishEnded()
      })
    )
    cleanups.push(
      session.onIntegration((event) => {
        if (event.kind !== "command_end" || ended) return
        ended = { exitCode: event.exit_code ?? null }
        if (hasCommandEndMarker(raw)) {
          finishEnded()
          return
        }
        graceTimer = setTimeout(finishEnded, END_CHUNK_GRACE_MS)
      })
    )
    cleanups.push(
      session.onExit(() => {
        // The shell died before reporting the command: there is no exit code
        // to give, and waiting out the timeout would only delay the caller.
        if (ended) finishEnded()
        else finish({ kind: "exited" })
      })
    )

    options.start?.()
  })
}
