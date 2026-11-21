import {
  __resetPetScopeForTesting,
  assertPetConversationScopeCurrent,
  bumpPetConversationGeneration,
  bumpPetGeneration,
  capturePetScope,
  enqueuePetWork,
  isPetConversationScopeCurrent,
  isPetScopeCurrent,
  notifyPetResetCompleted,
  onPetResetCompleted,
  PetScopeInvalidatedError,
  whenPetEventsSettled,
} from "./pet-scope"

beforeEach(() => {
  __resetPetScopeForTesting()
})

describe("lib/db/pet-scope", () => {
  it("fences conversation and pet generations independently", () => {
    const token = capturePetScope()
    expect(isPetScopeCurrent(token)).toBe(true)
    expect(isPetConversationScopeCurrent(token)).toBe(true)

    bumpPetConversationGeneration(token.databaseName)
    expect(isPetScopeCurrent(token)).toBe(true)
    expect(isPetConversationScopeCurrent(token)).toBe(false)
    expect(() => assertPetConversationScopeCurrent(token)).toThrow(PetScopeInvalidatedError)

    bumpPetGeneration(token.databaseName)
    expect(isPetScopeCurrent(token)).toBe(false)
  })

  it("serializes work and notifies reset-completed subscribers", async () => {
    const order: number[] = []
    const completed = jest.fn()
    const off = onPetResetCompleted(completed)
    try {
      await Promise.all([
        enqueuePetWork(async () => {
          order.push(1)
        }),
        enqueuePetWork(async () => {
          order.push(2)
        }),
      ])
      await whenPetEventsSettled()
      notifyPetResetCompleted("db-a")
      expect(order).toEqual([1, 2])
      expect(completed).toHaveBeenCalledWith("db-a")
    } finally {
      off()
    }
  })
})
