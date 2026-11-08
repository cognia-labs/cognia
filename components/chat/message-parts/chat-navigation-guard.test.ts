import { useChatStore } from "@/stores/chat"
import { captureChatNavigation } from "./chat-navigation-guard"

describe("captureChatNavigation", () => {
  const initial = useChatStore.getState()
  afterEach(() => {
    useChatStore.setState({
      activeSessionId: initial.activeSessionId,
      splitSessionId: initial.splitSessionId,
      openSessionIds: initial.openSessionIds,
    })
  })

  it("stays current while navigation is unchanged, including for a split-pane click", () => {
    useChatStore.setState({ activeSessionId: "a", splitSessionId: "b", openSessionIds: ["a", "b"] })
    const isCurrent = captureChatNavigation("b")
    expect(isCurrent()).toBe(true)
  })

  it.each([
    ["the focused conversation", { activeSessionId: "c" }],
    ["the split pane", { splitSessionId: null }],
    ["the clicked conversation's open state", { openSessionIds: ["a"] }],
  ])("goes stale when %s changes", (_label, patch) => {
    useChatStore.setState({ activeSessionId: "a", splitSessionId: "b", openSessionIds: ["a", "b"] })
    const isCurrent = captureChatNavigation("b")
    useChatStore.setState(patch)
    expect(isCurrent()).toBe(false)
  })
})
