"use client"

/**
 * Live state of a code slot's overrides (ADR-0236 §5.2), read from the
 * override tables through `useLiveQuery` so a publish from the CLI writer, a
 * second window or an import shows up without a manual refresh.
 */

import { useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import * as dbSchema from "@/lib/db/schema"
import {
  listPromptOverrideRevisions,
  type PromptOverrideRevisionRow,
} from "@/lib/db/prompt-overrides"
import { listPromptSlots, readPromptSlot, type PromptSlotState } from "@/lib/prompts/service"
import type { PromptTargetRef } from "@/lib/prompts/types"

function subscribeActiveDatabase(listener: () => void): () => void {
  return typeof dbSchema.onActiveDatabaseChange === "function"
    ? dbSchema.onActiveDatabaseChange(() => listener())
    : () => undefined
}

function readActiveDatabase(): string {
  try {
    if (typeof dbSchema.activeDatabaseName === "function") return dbSchema.activeDatabaseName()
    return dbSchema.getDb?.()?.name ?? ""
  } catch {
    return ""
  }
}

function useActivePromptDatabase(): string {
  return useSyncExternalStore(subscribeActiveDatabase, readActiveDatabase, () => "")
}

/** Every scope that holds a binding for the prompt; `undefined` while loading. */
export function usePromptSlots(promptId: string): PromptSlotState[] | undefined {
  const database = useActivePromptDatabase()
  const queryKey = `${database}:${promptId}`
  const queried = useLiveQuery(async () => {
    const slots = await listPromptSlots(promptId)
    return { queryKey, slots }
  }, [database, promptId])
  return queried?.queryKey === queryKey ? queried.slots : undefined
}

/** One slot and its history; `undefined` while loading or switching targets/accounts. */
export function usePromptSlot(
  promptId: string,
  target: PromptTargetRef
): { slot: PromptSlotState; revisions: PromptOverrideRevisionRow[] } | undefined {
  const database = useActivePromptDatabase()
  const queryKey = `${database}:${promptId}:${target.scope}:${target.targetId}`
  const queried = useLiveQuery(async () => {
    const slot = await readPromptSlot(promptId, target)
    const revisions = slot.binding ? await listPromptOverrideRevisions(slot.binding.id) : []
    return { queryKey, slot, revisions }
  }, [database, promptId, target.scope, target.targetId])
  return queried?.queryKey === queryKey
    ? { slot: queried.slot, revisions: queried.revisions }
    : undefined
}
