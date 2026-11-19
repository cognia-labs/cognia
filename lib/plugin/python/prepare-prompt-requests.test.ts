let mockHeadless = false
jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: () => mockHeadless }))

import {
  __resetPythonPreparePromptsForTests,
  finishPythonPreparePrompt,
  requestPythonPreparePrompt,
  subscribePythonPreparePrompts,
  type PythonPreparePromptState,
} from "./prepare-prompt-requests"

let seen: PythonPreparePromptState[] = []
let unsubscribe: () => void = () => undefined

beforeEach(() => {
  mockHeadless = false
  __resetPythonPreparePromptsForTests()
  seen = []
  unsubscribe = subscribePythonPreparePrompts((state) => seen.push(state))
})

afterEach(() => unsubscribe())

const last = () => seen[seen.length - 1]

describe("python prepare prompts", () => {
  it("tells a new subscriber what is open now", () => {
    expect(last()).toEqual({ current: null, queue: [] })
  })

  it("asks about one plugin at a time, in the order they were installed", () => {
    requestPythonPreparePrompt("a")
    requestPythonPreparePrompt("b")
    requestPythonPreparePrompt("c")
    expect(last()).toEqual({ current: "a", queue: ["b", "c"] })
    finishPythonPreparePrompt("a")
    expect(last()).toEqual({ current: "b", queue: ["c"] })
    finishPythonPreparePrompt("b")
    finishPythonPreparePrompt("c")
    expect(last()).toEqual({ current: null, queue: [] })
  })

  it("does not queue a plugin twice", () => {
    requestPythonPreparePrompt("a")
    requestPythonPreparePrompt("b")
    requestPythonPreparePrompt("a")
    requestPythonPreparePrompt("b")
    expect(last()).toEqual({ current: "a", queue: ["b"] })
  })

  it("drops a queued plugin that finished before its turn", () => {
    requestPythonPreparePrompt("a")
    requestPythonPreparePrompt("b")
    finishPythonPreparePrompt("b")
    expect(last()).toEqual({ current: "a", queue: [] })
  })

  it("asks nobody on a headless Host", () => {
    mockHeadless = true
    requestPythonPreparePrompt("a")
    expect(last()).toEqual({ current: null, queue: [] })
  })

  it("stops telling a listener that unsubscribed", () => {
    unsubscribe()
    const count = seen.length
    requestPythonPreparePrompt("a")
    expect(seen).toHaveLength(count)
  })
})
