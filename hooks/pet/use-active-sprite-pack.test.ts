import { renderHook } from "@testing-library/react"

const useLiveQuery = jest.fn()
const getPetSpritePack = jest.fn()
const isSpriteAssetMirror = jest.fn(() => false)
const getMirroredSpriteMeta = jest.fn()
const subscribeSpriteMirror = jest.fn((..._args: unknown[]) => () => {})

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQuery(...args),
}))
jest.mock("@/lib/db/pet-sprite-packs", () => ({
  getPetSpritePack: (...args: unknown[]) => getPetSpritePack(...args),
}))
jest.mock("@/lib/pet/sprite-v2/asset-bridge", () => ({
  isSpriteAssetMirror: () => isSpriteAssetMirror(),
  getMirroredSpriteMeta: (...args: unknown[]) => getMirroredSpriteMeta(...args),
  subscribeSpriteMirror: (...args: unknown[]) => subscribeSpriteMirror(...args),
}))

import { useActiveSpritePack } from "./use-active-sprite-pack"

describe("useActiveSpritePack", () => {
  beforeEach(() => {
    useLiveQuery.mockReset()
    getPetSpritePack.mockReset()
    isSpriteAssetMirror.mockReset().mockReturnValue(false)
    getMirroredSpriteMeta.mockReset()
    subscribeSpriteMirror.mockReset().mockReturnValue(() => {})
  })

  it("reactively resolves the configured pack", async () => {
    const row = { id: "momo", displayName: "Momo" }
    useLiveQuery.mockImplementation((query: () => Promise<unknown>) => {
      void query()
      return row
    })

    const { result } = renderHook(() =>
      useActiveSpritePack({ activeSpritePackId: "momo" } as never)
    )

    expect(getPetSpritePack).toHaveBeenCalledWith("momo")
    expect(result.current).toEqual({ packId: "momo", row })
  })

  it("does not query storage without an active id", async () => {
    let resultPromise: Promise<unknown> | undefined
    useLiveQuery.mockImplementation((query: () => Promise<unknown>) => {
      resultPromise = query()
      return undefined
    })
    const { result } = renderHook(() => useActiveSpritePack({} as never))
    await expect(resultPromise).resolves.toBeUndefined()
    expect(getPetSpritePack).not.toHaveBeenCalled()
    expect(result.current).toEqual({ packId: undefined, row: undefined })
  })

  it("reads mirrored sprite metadata in secondary windows without querying local storage (F28)", async () => {
    const mirroredMeta = {
      id: "momo",
      displayName: "Momo",
      description: "",
      spriteVersionNumber: 2,
      totalBytes: 100,
      createdAt: 1,
    }
    isSpriteAssetMirror.mockReturnValue(true)
    getMirroredSpriteMeta.mockReturnValue(mirroredMeta)
    let resultPromise: Promise<unknown> | undefined
    useLiveQuery.mockImplementation((query: () => Promise<unknown>) => {
      resultPromise = query()
      return undefined
    })

    const { result } = renderHook(() =>
      useActiveSpritePack({ activeSpritePackId: "momo" } as never, {
        skinId: "sprite-v2",
        packId: "momo",
      })
    )
    await expect(resultPromise).resolves.toBeUndefined()
    expect(getPetSpritePack).not.toHaveBeenCalled()
    expect(getMirroredSpriteMeta).toHaveBeenCalledWith("momo")
    expect(result.current).toEqual({ packId: "momo", row: mirroredMeta })
  })
})
