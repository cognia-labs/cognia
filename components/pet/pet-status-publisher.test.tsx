import { render } from "@testing-library/react"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { __resetTopicsForTesting, readTopic } from "@/lib/runtime/topics"
import type { PetProfile } from "@/types/pet"

let enabled = true
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (s: unknown) => unknown) =>
    select({ settings: { petSettings: { enabled } } }),
}))

// The query result the hook answers with, and whether the query ran.
let liveProfile: PetProfile | null = null
const queried = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => Promise<unknown>, _deps: unknown[], fallback: unknown) => {
    void query()
    return liveProfile ?? fallback
  },
}))
jest.mock("@/lib/db/pet", () => ({
  getPetProfile: async () => {
    queried()
    return liveProfile
  },
}))

import { PetStatusPublisher } from "./pet-status-publisher"

const NOW = 1_000_000

function hatched(): PetProfile {
  const base = createDefaultProfile("acct-1", NOW)
  return { ...base, needs: { ...base.needs, energy: 10, mood: 90 } }
}

beforeEach(() => {
  __resetTopicsForTesting()
  enabled = true
  liveProfile = null
  queried.mockClear()
})

describe("PetStatusPublisher", () => {
  it("publishes the pet's status, decayed to the moment a reader asks", () => {
    liveProfile = hatched()
    render(<PetStatusPublisher />)
    const status = readTopic("pet.status")
    expect(status?.enabled).toBe(true)
    const view = status?.at(NOW)
    expect(view?.band).toBe("low")
    expect(view?.needs.mood).toBeGreaterThan(80)
  })

  it("publishes an enabled pet with no profile yet as no pet", () => {
    render(<PetStatusPublisher />)
    expect(readTopic("pet.status")?.enabled).toBe(true)
    expect(readTopic("pet.status")?.at(NOW)).toBeNull()
  })

  it("does not read the profile while the pet is off", () => {
    enabled = false
    liveProfile = hatched()
    render(<PetStatusPublisher />)
    expect(queried).not.toHaveBeenCalled()
    expect(readTopic("pet.status")?.enabled).toBe(false)
  })

  it("republishes when the profile changes", () => {
    const { rerender } = render(<PetStatusPublisher />)
    const before = readTopic("pet.status")
    liveProfile = hatched()
    rerender(<PetStatusPublisher />)
    expect(readTopic("pet.status")).not.toBe(before)
    expect(readTopic("pet.status")?.at(NOW)).not.toBeNull()
  })

  it("withdraws the topic when it unmounts", () => {
    liveProfile = hatched()
    const { unmount } = render(<PetStatusPublisher />)
    unmount()
    expect(readTopic("pet.status")).toBeUndefined()
  })
})
