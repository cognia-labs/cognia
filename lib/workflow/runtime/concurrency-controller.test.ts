import { createConcurrencyController } from "./concurrency-controller"

describe("ConcurrencyController", () => {
  it("starts at initial value", () => {
    const c = createConcurrencyController(5)
    expect(c.get()).toBe(5)
  })

  it("rejects negative initial value", () => {
    expect(() => createConcurrencyController(-1)).toThrow(/non-negative/)
  })

  it("rejects non-integer initial value", () => {
    expect(() => createConcurrencyController(1.5)).toThrow(/integer/)
  })

  it("reduceTo lowers the cap", () => {
    const c = createConcurrencyController(5)
    c.reduceTo(2)
    expect(c.get()).toBe(2)
  })

  it("reduceTo cannot raise the cap", () => {
    const c = createConcurrencyController(2)
    c.reduceTo(5)
    expect(c.get()).toBe(2)
  })

  it("reduceTo to 0 fully pauses dispatch", () => {
    const c = createConcurrencyController(5)
    c.reduceTo(0)
    expect(c.get()).toBe(0)
  })

  it("rejects negative reduceTo", () => {
    const c = createConcurrencyController(5)
    expect(() => c.reduceTo(-1)).toThrow(/non-negative/)
  })

  it("subscribe fires on actual change", () => {
    const c = createConcurrencyController(5)
    const fn = jest.fn()
    c.subscribe(fn)
    c.reduceTo(3)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)
  })

  it("subscribe does not fire when reduceTo is a no-op", () => {
    const c = createConcurrencyController(5)
    const fn = jest.fn()
    c.subscribe(fn)
    c.reduceTo(7)
    expect(fn).not.toHaveBeenCalled()
  })

  it("unsubscribe stops notifications", () => {
    const c = createConcurrencyController(5)
    const fn = jest.fn()
    const unsub = c.subscribe(fn)
    unsub()
    c.reduceTo(3)
    expect(fn).not.toHaveBeenCalled()
  })

  it("isolates listener errors so other listeners still fire", () => {
    const c = createConcurrencyController(5)
    const bad = jest.fn(() => {
      throw new Error("boom")
    })
    const good = jest.fn()
    c.subscribe(bad)
    c.subscribe(good)
    c.reduceTo(3)
    expect(good).toHaveBeenCalledWith(3)
  })

  it("can reduce multiple times monotonically", () => {
    const c = createConcurrencyController(10)
    c.reduceTo(5)
    c.reduceTo(2)
    c.reduceTo(0)
    expect(c.get()).toBe(0)
  })

  it("holdGate freezes concurrency at 0 and restores the monotone cap on release", () => {
    const c = createConcurrencyController(4)
    const events: number[] = []
    c.subscribe((n) => events.push(n))

    const release1 = c.holdGate!()
    expect(c.get()).toBe(0)
    expect(events).toEqual([0])

    const release2 = c.holdGate!()
    // Permanent downshift while held must be remembered when the hold lifts.
    c.reduceTo(1)
    expect(c.get()).toBe(0)

    release1()
    expect(c.get()).toBe(0)
    release2()
    release2() // idempotent
    expect(c.get()).toBe(1)
    expect(events).toEqual([0, 1])
  })
})
