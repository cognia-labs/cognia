import type { PetSpritePackRow } from "@/lib/db/pet-sprite-packs"
import { resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"
import { SpriteAssetMirror, startMainSpriteAssets, type SpriteAssetChannel } from "./asset-bridge"

function pairChannels(): [SpriteAssetChannel, SpriteAssetChannel] {
  const left: SpriteAssetChannel = {
    onmessage: null,
    postMessage: (data) => right.onmessage?.({ data }),
    close: () => {
      left.onmessage = null
    },
  }
  const right: SpriteAssetChannel = {
    onmessage: null,
    postMessage: (data) => left.onmessage?.({ data }),
    close: () => {
      right.onmessage = null
    },
  }
  return [left, right]
}

function makePack(id: string, bytes = "webp-atlas"): PetSpritePackRow {
  const spritesheet = new Blob([bytes], { type: "image/webp" })
  return {
    id,
    displayName: `Pack ${id}`,
    description: "Test sprite pack",
    spriteVersionNumber: 2,
    spritesheet,
    totalBytes: spritesheet.size,
    createdAt: 1000,
  }
}

beforeEach(() => {
  resetPetSkinRuntimeForTests()
})

describe("sprite-v2 asset bridge (F28)", () => {
  it("projects selected sprite metadata and atlas bytes from main to secondary windows", async () => {
    const [mainWire, overlayWire] = pairChannels()
    const momo = makePack("momo", "atlas-bytes")
    let selected: string | undefined = "momo"
    let publishRow: ((row: PetSpritePackRow | undefined) => void) | undefined

    const host = startMainSpriteAssets({
      channel: mainWire,
      selectedPack: () => selected,
      readPack: async (id) => (id === "momo" ? momo : undefined),
      watchRow: (_id, next) => {
        publishRow = next
        next(momo)
        return () => {}
      },
    })

    const mirror = new SpriteAssetMirror(overlayWire)
    const onChange = jest.fn()
    mirror.subscribe(onChange)

    // Overlay immediately sees the mirrored metadata after hello handshake.
    expect(mirror.metas.get("momo")).toEqual({
      id: "momo",
      displayName: "Pack momo",
      description: "Test sprite pack",
      spriteVersionNumber: 2,
      totalBytes: momo.totalBytes,
      createdAt: 1000,
    })

    // On-demand asset fetch transfers the atlas Blob cleanly.
    const fetched = await mirror.request("momo")
    expect(fetched).toMatchObject({ id: "momo", displayName: "Pack momo" })
    expect(fetched?.spritesheet).toBe(momo.spritesheet)

    // Deleting the pack in main clears mirrored metadata immediately.
    publishRow?.(undefined)
    expect(mirror.metas.get("momo")).toBeUndefined()
    expect(onChange).toHaveBeenCalled()

    // Revoking on account switch / deselect cleans up and refuses unselected requests.
    selected = undefined
    host.sync()
    expect(mirror.metas.size).toBe(0)

    mirror.dispose()
    host.dispose()
  })

  it("ignores requests for packs that are not currently selected and revokes on switch", async () => {
    const [mainWire, overlayWire] = pairChannels()
    const a = makePack("pack-a", "aaa")
    const b = makePack("pack-b", "bbb")
    let selected: string | undefined = "pack-a"

    const readPack = jest.fn(async (id: string) =>
      id === "pack-a" ? a : id === "pack-b" ? b : undefined
    )
    const host = startMainSpriteAssets({
      channel: mainWire,
      selectedPack: () => selected,
      readPack,
      watchRow: (id, next) => {
        next(id === "pack-a" ? a : id === "pack-b" ? b : undefined)
        return () => {}
      },
    })
    const mirror = new SpriteAssetMirror(overlayWire, 50)

    // Requesting an unselected pack times out without reading it on main.
    await expect(mirror.request("pack-b")).resolves.toBeUndefined()
    expect(readPack).not.toHaveBeenCalledWith("pack-b")

    // Switching selection revokes pack-a and exposes pack-b.
    selected = "pack-b"
    host.sync()
    expect(mirror.metas.get("pack-a")).toBeUndefined()
    expect(mirror.metas.get("pack-b")?.id).toBe("pack-b")
    const loaded = await mirror.request("pack-b")
    expect(loaded?.id).toBe("pack-b")

    mirror.dispose()
    host.dispose()
  })
})
