import {
  __resetDbForTesting,
  activateAccountDatabase,
  clearAccountDatabaseSelection,
} from "@/lib/db/schema"
import {
  __resetPetScopeForTesting,
  assertPetConversationScopeCurrent,
  assertPetScopeCurrent,
  bumpPetConversationGeneration,
  bumpPetGeneration,
  capturePetScope,
  isPetConversationScopeCurrent,
  isPetDatabaseCurrent,
  isPetScopeCurrent,
  onPetConversationCleared,
  onPetReset,
  PetScopeInvalidatedError,
} from "./pet-scope"

describe("pet-scope", () => {
  beforeEach(() => {
    __resetDbForTesting()
    __resetPetScopeForTesting()
  })

  it("invalidates tokens on account switch and on lock→unlock of the same account", () => {
    activateAccountDatabase("acct-a")
    const tokenA = capturePetScope()
    expect(isPetDatabaseCurrent(tokenA)).toBe(true)
    expect(isPetScopeCurrent(tokenA)).toBe(true)

    activateAccountDatabase("acct-b")
    expect(isPetDatabaseCurrent(tokenA)).toBe(false)
    expect(() => assertPetScopeCurrent(tokenA)).toThrow(PetScopeInvalidatedError)

    // Locking and re-activating the original account still rejects the pre-lock token.
    clearAccountDatabaseSelection()
    activateAccountDatabase("acct-a")
    expect(isPetDatabaseCurrent(tokenA)).toBe(false)
    expect(isPetConversationScopeCurrent(tokenA)).toBe(false)
  })

  it("bumps conversation generation independently of pet generation", () => {
    activateAccountDatabase("acct-a")
    const token = capturePetScope()
    const cleared = jest.fn()
    const reset = jest.fn()
    const offCleared = onPetConversationCleared(cleared)
    const offReset = onPetReset(reset)

    bumpPetConversationGeneration()
    expect(isPetScopeCurrent(token)).toBe(true)
    expect(isPetConversationScopeCurrent(token)).toBe(false)
    expect(() => assertPetConversationScopeCurrent(token)).toThrow("conversation-cleared")
    expect(cleared).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()

    offCleared()
    offReset()
  })

  it("bumps both pet and conversation generations on reset", () => {
    activateAccountDatabase("acct-a")
    const token = capturePetScope()
    const cleared = jest.fn()
    const reset = jest.fn()
    const offCleared = onPetConversationCleared(cleared)
    const offReset = onPetReset(reset)

    bumpPetGeneration()
    expect(isPetScopeCurrent(token)).toBe(false)
    expect(isPetConversationScopeCurrent(token)).toBe(false)
    expect(() => assertPetScopeCurrent(token)).toThrow("pet-reset")
    expect(cleared).toHaveBeenCalledTimes(1)
    expect(reset).toHaveBeenCalledTimes(1)

    offCleared()
    offReset()
  })
})
