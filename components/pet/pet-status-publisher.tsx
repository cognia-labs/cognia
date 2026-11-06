"use client"

// Publishes the `pet.status` topic (`types/pet/events.ts`, ADR-0250 §14): the
// tray menu, the tray panel's glance and a phone's glance read the pet's mood
// and needs from it instead of importing the pet.
//
// Mounted by `ModuleEffectsHost` in every window, on every host, because the
// readers are spread across them (the main window's tray and glance builds,
// Settings' tray-panel preview, a standalone phone's glance). It reads the
// same stored profile they used to read themselves, and only while the pet is
// switched on. When it unmounts the topic is withdrawn, and readers fall back
// to "no pet".

import { useEffect, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getPetProfile } from "@/lib/db/pet"
import { petStatusTopic } from "@/lib/pet/status"
import { clearTopic, publishTopic } from "@/lib/runtime/topics"
import { useSettingsStore } from "@/stores/settings"

export function PetStatusPublisher(): null {
  const enabled = useSettingsStore((s) => s.settings?.petSettings?.enabled ?? false)
  // `null` (not `undefined`) once read, so "no profile yet" is a value and
  // not "still loading"; off, the table is not read at all.
  const profile = useLiveQuery(
    async () => (enabled ? ((await getPetProfile()) ?? null) : null),
    [enabled],
    null
  )
  const status = useMemo(() => petStatusTopic(enabled, profile), [enabled, profile])

  useEffect(() => {
    publishTopic("pet.status", status)
  }, [status])

  useEffect(() => () => clearTopic("pet.status"), [])

  return null
}

export default PetStatusPublisher
