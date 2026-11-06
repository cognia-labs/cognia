import { act, renderHook } from "@testing-library/react"
import { __resetTopicsForTesting, clearTopic, publishTopic } from "@/lib/runtime/topics"
import { useTopic } from "./use-topic"

declare module "@/lib/runtime/topics" {
  interface TopicMap {
    "test.hook": { n: number }
  }
}

beforeEach(() => __resetTopicsForTesting())

describe("useTopic", () => {
  it("is undefined until the topic is published", () => {
    const { result } = renderHook(() => useTopic("test.hook"))
    expect(result.current).toBeUndefined()
  })

  it("starts from the value published before it mounted", () => {
    const value = { n: 1 }
    publishTopic("test.hook", value)
    const { result } = renderHook(() => useTopic("test.hook"))
    expect(result.current).toBe(value)
  })

  it("re-renders with each new value and on withdrawal", () => {
    const { result } = renderHook(() => useTopic("test.hook"))
    act(() => publishTopic("test.hook", { n: 2 }))
    expect(result.current).toEqual({ n: 2 })
    act(() => clearTopic("test.hook"))
    expect(result.current).toBeUndefined()
  })

  it("stops listening when it unmounts", () => {
    const { result, unmount } = renderHook(() => useTopic("test.hook"))
    unmount()
    act(() => publishTopic("test.hook", { n: 3 }))
    expect(result.current).toBeUndefined()
  })
})
