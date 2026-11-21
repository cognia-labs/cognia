"use client"

import { useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getPetSpritePack } from "@/lib/db/pet-sprite-packs"
import {
  getMirroredSpriteMeta,
  isSpriteAssetMirror,
  subscribeSpriteMirror,
  type SpritePackMeta,
} from "@/lib/pet/sprite-v2/asset-bridge"
import type { PetSettings, PetSkinSelection } from "@/types/pet"

export interface ActiveSpritePack {
  packId: string | undefined
  row: SpritePackMeta | undefined
}

/**
 * Reactively resolve the installed v2 sprite pack selected in settings, or its
 * read-only overlay projection in secondary pet windows (F28).
 */
export function useActiveSpritePack(
  settings: Pick<PetSettings, "activeSpritePackId">,
  selection?: PetSkinSelection
): ActiveSpritePack {
  const packId =
    selection?.skinId === "sprite-v2"
      ? selection.packId
      : selection
        ? undefined
        : settings.activeSpritePackId
  const mirrored = isSpriteAssetMirror()
  const local = useLiveQuery(
    () => (!mirrored && packId ? getPetSpritePack(packId) : Promise.resolve(undefined)),
    [mirrored, packId],
    undefined
  )
  const remote = useSyncExternalStore(
    subscribeSpriteMirror,
    () => (mirrored && packId ? getMirroredSpriteMeta(packId) : undefined),
    () => undefined
  )
  return { packId, row: mirrored ? remote : local }
}
