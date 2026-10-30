"use client"

// Dexie-backed implementation of `DataAdapter` — the production adapter for
// the PC desktop app. Reactive reads delegate to `dexie-react-hooks`'
// `useLiveQuery`; mutations are direct passthroughs to the existing helpers
// under `lib/db/*`. The shape is identical to what the chat components were
// doing inline before this refactor — same SSR guards, same dependency keys.

import { useLiveQuery } from "dexie-react-hooks"
import { listCharacters, resolveCharacterById } from "@/lib/db/characters"
import { listSkillsByIds } from "@/lib/db/skills"
import { listPresets, recordPresetUsage } from "@/lib/db/prompt-presets"
import { updateSession } from "@/lib/db/sessions"
import { clearMessages } from "@/lib/db/messages"
import { trustWorkspace } from "@/lib/db/trusted-workspaces"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { DataAdapter, SessionPatch } from "./types"

const isClient = (): boolean => typeof window !== "undefined"

/**
 * Singleton — `DataAdapter` instance backed by Dexie. The hook properties
 * (`useCharacters` etc.) ARE React hooks; consumers must respect React's
 * rules of hooks at the call site (i.e. call them at the top of a component).
 */
export const dexieAdapter: DataAdapter = {
  useCharacters() {
    const plugins = usePluginStore((state) => state.plugins)
    return useLiveQuery(() => (isClient() ? listCharacters() : Promise.resolve([])), [plugins])
  },

  useCharacter(id) {
    // Overlay characters and dormant chat participants also change when a
    // manifest changes without changing the count of enabled extensions.
    const plugins = usePluginStore((state) => state.plugins)
    return useLiveQuery(
      () => (isClient() && id ? resolveCharacterById(id) : Promise.resolve(undefined)),
      [id ?? "", plugins]
    )
  },

  useSkillsByIds(ids) {
    // Stable string key so `useLiveQuery` re-runs only when membership changes,
    // not on every parent re-render that produces a new array reference.
    const key = ids?.join(",") ?? ""
    return useLiveQuery(
      () => (isClient() && ids && ids.length > 0 ? listSkillsByIds([...ids]) : Promise.resolve([])),
      [key]
    )
  },

  usePresets() {
    return useLiveQuery(() => (isClient() ? listPresets() : Promise.resolve([])), [])
  },

  async clearMessages(sessionId: string): Promise<void> {
    await clearMessages(sessionId)
  },

  async updateSession(id: string, patch: SessionPatch): Promise<void> {
    await updateSession(id, patch)
  },

  async recordPresetUsage(id: string): Promise<void> {
    await recordPresetUsage(id)
  },

  async trustWorkspace(path: string, note?: string): Promise<void> {
    await trustWorkspace(path, note)
  },
}
