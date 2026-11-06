import {
  __resetPetIdempotencyLedgerForTesting,
  createPetIdempotencyLedger,
  getPetIdempotencyLedger,
} from "./idempotency"

describe("pet idempotency ledger", () => {
  it("is the companion ledger: runs an intent once and replays its answer", async () => {
    const ledger = createPetIdempotencyLedger({ now: () => 0 })
    const fn = jest.fn(async () => ({ ok: true }))
    const first = await ledger.run("phone", "k1", fn)
    const second = await ledger.run("phone", "k1", fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it("shares one process-wide ledger until reset", () => {
    const a = getPetIdempotencyLedger()
    expect(getPetIdempotencyLedger()).toBe(a)
    __resetPetIdempotencyLedgerForTesting()
    expect(getPetIdempotencyLedger()).not.toBe(a)
  })
})
