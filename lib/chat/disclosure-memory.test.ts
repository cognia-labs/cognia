import {
  DISCLOSURE_MEMORY_LIMIT,
  disclosureKey,
  readDisclosure,
  resetDisclosureMemory,
  subscribeDisclosure,
  writeDisclosure,
  writeDisclosures,
} from "./disclosure-memory"

describe("disclosure memory", () => {
  afterEach(() => resetDisclosureMemory())

  it("builds keys from a scope and segments, with a placeholder for no scope", () => {
    expect(disclosureKey("s1", "m1", "tool", "call-7")).toBe("s1:m1:tool:call-7")
    expect(disclosureKey(null, "m1", 3)).toBe("-:m1:3")
    expect(disclosureKey(undefined, "fold")).toBe("-:fold")
  })

  it("stores only explicit choices", () => {
    expect(readDisclosure("a")).toBeUndefined()
    writeDisclosure("a", true)
    expect(readDisclosure("a")).toBe(true)
    writeDisclosure("a", false)
    expect(readDisclosure("a")).toBe(false)
  })

  it("notifies a key's subscribers only when its value changes", () => {
    const listener = jest.fn()
    const other = jest.fn()
    const unsubscribe = subscribeDisclosure("a", listener)
    subscribeDisclosure("b", other)

    writeDisclosure("a", true)
    writeDisclosure("a", true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()

    unsubscribe()
    writeDisclosure("a", false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("writes several keys at once", () => {
    writeDisclosures(["x", "y"], true)
    expect(readDisclosure("x")).toBe(true)
    expect(readDisclosure("y")).toBe(true)
  })

  it("forgets the least recently written choice past the limit and tells its subscribers", () => {
    const evicted = jest.fn()
    writeDisclosure("first", true)
    subscribeDisclosure("first", evicted)
    // Touching "first" again moves it to the back of the queue.
    writeDisclosure("second", true)
    writeDisclosure("first", false)
    evicted.mockClear()
    for (let i = 0; i < DISCLOSURE_MEMORY_LIMIT - 1; i++) writeDisclosure(`k${i}`, true)
    expect(readDisclosure("second")).toBeUndefined()
    expect(readDisclosure("first")).toBe(false)
    writeDisclosure("one-more", true)
    expect(readDisclosure("first")).toBeUndefined()
    expect(evicted).toHaveBeenCalledTimes(1)
  })

  it("reset clears every choice and notifies", () => {
    const listener = jest.fn()
    writeDisclosure("a", true)
    subscribeDisclosure("a", listener)
    resetDisclosureMemory()
    expect(readDisclosure("a")).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
