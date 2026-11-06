import { NEUTRAL_MOOD_CEILING, UNWELL_NEED_THRESHOLD } from "@/lib/pet/care/condition"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"
import { petNeedsBand, petStatusTopic, petStatusView } from "./status"

function profile(needs: Partial<PetProfile["needs"]> = {}, at = 0): PetProfile {
  const base = createDefaultProfile("acct-1", at)
  return { ...base, needs: { ...base.needs, ...needs, lastTickAt: new Date(at).toISOString() } }
}

describe("petNeedsBand", () => {
  it("bands the lower of energy and mood on the care thresholds", () => {
    expect(petNeedsBand({ energy: UNWELL_NEED_THRESHOLD - 1, mood: 100 })).toBe("low")
    expect(petNeedsBand({ energy: 100, mood: UNWELL_NEED_THRESHOLD })).toBe("neutral")
    expect(petNeedsBand({ energy: NEUTRAL_MOOD_CEILING - 1, mood: 100 })).toBe("neutral")
    expect(petNeedsBand({ energy: NEUTRAL_MOOD_CEILING, mood: NEUTRAL_MOOD_CEILING })).toBe("high")
  })
})

describe("petStatusView", () => {
  it("agrees with the console's view, decayed to the moment asked for", () => {
    const stored = profile({ energy: 80, mood: 70, bond: 40 })
    const now = 3 * 3_600_000
    const view = computePetView(stored, null, now)
    expect(petStatusView(stored, now)).toEqual({
      mood: view.mood,
      condition: view.condition,
      needs: { energy: view.needs.energy, mood: view.needs.mood, bond: view.needs.bond },
      band: petNeedsBand(view.needs),
    })
  })
})

describe("petStatusTopic", () => {
  it("answers null while the pet is off", () => {
    const status = petStatusTopic(false, profile())
    expect(status.enabled).toBe(false)
    expect(status.at(0)).toBeNull()
  })

  it("answers null while there is no profile yet", () => {
    expect(petStatusTopic(true, undefined).at(0)).toBeNull()
    expect(petStatusTopic(true, null).at(0)).toBeNull()
  })

  it("decays the pet to each moment it is asked about", () => {
    const status = petStatusTopic(true, profile({ energy: 90, mood: 90 }))
    const early = status.at(0)
    const late = status.at(48 * 3_600_000)
    expect(status.enabled).toBe(true)
    expect(early?.needs.energy).toBeGreaterThan(late?.needs.energy ?? Infinity)
  })
})
