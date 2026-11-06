import {
  __resetTopicsForTesting,
  clearTopic,
  publishTopic,
  readTopic,
  subscribeTopic,
} from "./topics"

declare module "./topics" {
  interface TopicMap {
    "test.count": number
    "test.status": { on: boolean }
  }
}

beforeEach(() => __resetTopicsForTesting())

describe("typed topics", () => {
  it("reads undefined before anyone publishes", () => {
    expect(readTopic("test.count")).toBeUndefined()
  })

  it("keeps the latest value for a reader that comes later", () => {
    publishTopic("test.count", 1)
    publishTopic("test.count", 2)
    expect(readTopic("test.count")).toBe(2)
  })

  it("tells every listener synchronously, and stops after unsubscribe", () => {
    const heard: Array<number | undefined> = []
    const off = subscribeTopic("test.count", (value) => heard.push(value))
    publishTopic("test.count", 5)
    off()
    publishTopic("test.count", 6)
    expect(heard).toEqual([5])
  })

  it("does not repeat the same value", () => {
    const listener = jest.fn()
    subscribeTopic("test.status", listener)
    const value = { on: true }
    publishTopic("test.status", value)
    publishTopic("test.status", value)
    expect(listener).toHaveBeenCalledTimes(1)
    publishTopic("test.status", { on: true })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("withdraws a topic when its publisher stops", () => {
    const listener = jest.fn()
    publishTopic("test.count", 3)
    subscribeTopic("test.count", listener)
    clearTopic("test.count")
    expect(readTopic("test.count")).toBeUndefined()
    expect(listener).toHaveBeenCalledWith(undefined)
    // Clearing an unpublished topic tells nobody.
    clearTopic("test.count")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("publishes 0 and other falsy values like any other", () => {
    const listener = jest.fn()
    subscribeTopic("test.count", listener)
    publishTopic("test.count", 0)
    expect(readTopic("test.count")).toBe(0)
    expect(listener).toHaveBeenCalledWith(0)
  })

  it("keeps topics apart", () => {
    publishTopic("test.count", 1)
    expect(readTopic("test.status")).toBeUndefined()
  })

  it("isolates a listener that throws from the others", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    const after = jest.fn()
    subscribeTopic("test.count", () => {
      throw new Error("boom")
    })
    subscribeTopic("test.count", after)
    publishTopic("test.count", 1)
    expect(after).toHaveBeenCalledWith(1)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it("does not let a listener that unsubscribes mid-publish skip another", () => {
    const second = jest.fn()
    const offFirst = subscribeTopic("test.count", () => offFirst())
    subscribeTopic("test.count", second)
    publishTopic("test.count", 1)
    expect(second).toHaveBeenCalledWith(1)
  })
})
