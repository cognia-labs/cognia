"use client"

/**
 * What the execution Host can do with `run_code`, for the mode pickers
 * (ADR-0117, Phase 4).
 *
 * Starts at `probing` — native only — and settles on the Host's own report
 * (`claude_sidecar_status`). The initial value matters: rendering `code` as
 * available and then retracting it would let a user select it in the gap.
 *
 * The answer belongs to one Host and one sidecar generation, so it is asked
 * again when either changes: a switch of the bound Host resets it to
 * `probing` (the old answer describes another machine), and a sidecar
 * `ready` or `sidecar_exited` frame re-asks in place (a restart can come back
 * with or without a launcher, or with the Host's kill switch now set).
 */

import { useEffect, useMemo, useState } from "react"

import {
  CODE_HOST_PROBING,
  codeModeUnavailableReason,
  supportedToolPresentations,
} from "@/lib/ai/code-mode/availability"
import type { CodeHostCapability, CodeModeUnavailableReason } from "@/lib/ai/code-mode/availability"
import { readCodeHostCapability } from "@/lib/ai/code-mode/host-capability"
import { transport } from "@/lib/tauri"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { ToolPresentationMode } from "@cognia/agent-config-types/agent-composition"

/** The sidecar's raw frame channel; `ready` and `sidecar_exited` ride on it. */
const SIDECAR_EVENT = "claude://message"
const GENERATION_FRAMES = new Set(["ready", "sidecar_exited"])

export interface CodeHostCapabilityView {
  capability: CodeHostCapability
  /** The presentations to offer: native only unless the Host can sandbox. */
  presentations: ToolPresentationMode[]
  /** Why Code / Both are off, or `null` when they are offered. */
  unavailableReason: CodeModeUnavailableReason | "probing" | null
}

export function useCodeHostCapability(): CodeHostCapabilityView {
  const [capability, setCapability] = useState<CodeHostCapability>(CODE_HOST_PROBING)

  useEffect(() => {
    let alive = true
    // Only the newest question may answer: a slow reply from the previous Host
    // must not land after the switch.
    let asked = 0
    const ask = () => {
      const ticket = ++asked
      void readCodeHostCapability().then((next) => {
        if (alive && ticket === asked) setCapability(next)
      })
    }
    ask()
    const offRemote = subscribeActiveRemoteTransport(() => {
      if (!alive) return
      setCapability(CODE_HOST_PROBING)
      ask()
    })
    let offFrames: () => void = () => {}
    try {
      offFrames = transport.subscribe<{ type?: unknown }>(SIDECAR_EVENT, (frame) => {
        if (alive && typeof frame?.type === "string" && GENERATION_FRAMES.has(frame.type)) ask()
      })
    } catch {
      // A shell without an event channel has no sidecar to restart.
    }
    return () => {
      alive = false
      offRemote()
      offFrames()
    }
  }, [])

  // Stable per answer: the pickers key their resolved summary on this list.
  return useMemo(
    () => ({
      capability,
      presentations: supportedToolPresentations(capability),
      unavailableReason: codeModeUnavailableReason(capability),
    }),
    [capability]
  )
}
