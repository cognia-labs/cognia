import type { PetStatusTopic, PetStatusView } from "@/types/pet/events"

import { buildPetSlice } from "./build-pet"

const NOW = 1_800_000_000_000

const DISABLED = {
  updatedAt: NOW,
  enabled: false,
  mood: null,
  condition: null,
  energy: 0,
  moodLevel: 0,
  bond: 0,
}

function status(enabled: boolean, view: PetStatusView | null): PetStatusTopic & { at: jest.Mock } {
  return { enabled, at: jest.fn(() => view) }
}

const view = (over: Partial<PetStatusView> = {}): PetStatusView => ({
  mood: "happy",
  condition: "well",
  needs: { energy: 61.4, mood: 72.5, bond: 10.49 },
  band: "high",
  ...over,
})

describe("buildPetSlice", () => {
  it("is disabled with zeros while nothing publishes pet.status here", () => {
    expect(buildPetSlice(undefined, NOW)).toEqual(DISABLED)
  })

  it("is disabled with zeros when the pet is off, without asking it", () => {
    const off = status(false, view())
    expect(buildPetSlice(off, NOW)).toEqual(DISABLED)
    expect(off.at).not.toHaveBeenCalled()
  })

  it("is disabled with zeros when the pet has no profile yet", () => {
    expect(buildPetSlice(status(true, null), NOW)).toEqual(DISABLED)
  })

  it("reads mood, condition and rounded needs, decayed to the build's now", () => {
    const on = status(true, view())
    expect(buildPetSlice(on, NOW)).toEqual({
      updatedAt: NOW,
      enabled: true,
      mood: "happy",
      condition: "well",
      energy: 61,
      moodLevel: 73,
      bond: 10,
    })
    expect(on.at).toHaveBeenCalledWith(NOW)
  })

  it("keeps an unwell, lonely pet's state", () => {
    const lonely = status(
      true,
      view({
        mood: "lonely",
        condition: "unwell",
        needs: { energy: 3.2, mood: 0.4, bond: 99.6 },
        band: "low",
      })
    )
    expect(buildPetSlice(lonely, NOW)).toMatchObject({
      mood: "lonely",
      condition: "unwell",
      energy: 3,
      moodLevel: 0,
      bond: 100,
    })
  })
})
