"use client"

/**
 * The two answers to a conflict, shared by both conflict panels.
 *
 * A bidirectional-sync conflict (`sync-conflicts-panel.tsx`) and a shared
 * workspace's refused change (`collab-conflicts-panel.tsx`) ask the same
 * question: keep what this device has, or take what the other side has. Each
 * panel keeps its own store and its own wording; the buttons, their order
 * (this device first), the one-at-a-time busy state and the error line are
 * this file's, so the two panels cannot drift apart.
 */

import { useCallback, useState } from "react"

import { Button } from "@/components/ui/button"

export interface ConflictChoice {
  label: string
  onSelect: () => void
  /** Draw this one as the primary button: the side the panel suggests. */
  recommended?: boolean
  testId?: string
}

export interface ConflictResolutionActionsProps {
  /** Keep this device's version. */
  keepLocal: ConflictChoice
  /** Take the other side's version. */
  keepRemote: ConflictChoice
  disabled?: boolean
}

export function ConflictResolutionActions({
  keepLocal,
  keepRemote,
  disabled,
}: ConflictResolutionActionsProps) {
  return (
    <div className="flex gap-2">
      {[keepLocal, keepRemote].map((choice) => (
        <Button
          key={choice.label}
          size="sm"
          variant={choice.recommended ? "default" : "outline"}
          disabled={disabled}
          onClick={choice.onSelect}
          data-testid={choice.testId}
        >
          {choice.label}
        </Button>
      ))}
    </div>
  )
}

/**
 * One resolution in flight at a time, and the last failure's message. `run`
 * marks `id` busy, awaits the resolution and records why it failed, if it did.
 */
export function useConflictResolution(): {
  busyId: string | null
  error: string | null
  run: (id: string, resolve: () => Promise<unknown>) => Promise<void>
} {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (id: string, resolve: () => Promise<unknown>) => {
    setBusyId(id)
    setError(null)
    try {
      await resolve()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
    }
  }, [])
  return { busyId, error, run }
}
