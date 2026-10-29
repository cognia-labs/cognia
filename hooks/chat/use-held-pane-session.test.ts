/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

import { useHeldPaneSession } from "./use-held-pane-session"

const row = (id: string) => ({ id, title: id }) as unknown as ChatSession

type Props = { session: ChatSession | null; sessionId: string | undefined; pending: boolean }

function setup(initial: Props) {
  return renderHook(
    (props: Props) => useHeldPaneSession(props.session, props.sessionId, props.pending),
    {
      initialProps: initial,
    }
  )
}

describe("useHeldPaneSession", () => {
  it("passes a resolved session straight through", () => {
    const a = row("a")
    const { result } = setup({ session: a, sessionId: "a", pending: false })
    expect(result.current).toEqual({ session: a, sessionId: "a", held: false })
  })

  it("holds the previous conversation while the next row is pending, then swaps once", () => {
    const a = row("a")
    const b = row("b")
    const { result, rerender } = setup({ session: a, sessionId: "a", pending: false })
    rerender({ session: null, sessionId: "b", pending: true })
    expect(result.current).toEqual({ session: a, sessionId: "a", held: true })
    rerender({ session: b, sessionId: "b", pending: false })
    expect(result.current).toEqual({ session: b, sessionId: "b", held: false })
  })

  it("shows nothing for a session that resolved absent, and holds nothing afterwards", () => {
    const a = row("a")
    const { result, rerender } = setup({ session: a, sessionId: "a", pending: false })
    rerender({ session: null, sessionId: "gone", pending: false })
    expect(result.current).toEqual({ session: null, sessionId: "gone", held: false })
    // Home, then a pending first visit: the conversation from before home
    // must not come back.
    rerender({ session: null, sessionId: "c", pending: true })
    expect(result.current).toEqual({ session: null, sessionId: "c", held: false })
  })

  it("has nothing to hold on a cold start", () => {
    const { result } = setup({ session: null, sessionId: "a", pending: true })
    expect(result.current.held).toBe(false)
    expect(result.current.session).toBeNull()
  })
})
