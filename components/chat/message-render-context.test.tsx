/** @jest-environment jsdom */
import { render } from "@testing-library/react"

import type { MessageRenderContextValue } from "@/lib/chat/message-render-context"

import { MessageRenderProvider, useMessageRenderContext } from "./message-render-context"

function capture() {
  const seen: MessageRenderContextValue[] = []
  function Probe() {
    seen.push(useMessageRenderContext())
    return null
  }
  return { seen, Probe }
}

it("is empty outside a provider", () => {
  const { seen, Probe } = capture()
  render(<Probe />)
  expect(seen.at(-1)).toEqual({})
})

it("merges a nested provider over its parent", () => {
  const { seen, Probe } = capture()
  const onCopy = jest.fn()
  const outer = { onCopy, projectRoot: "/repo", canMutate: (id: string) => id !== "x" }
  const inner = { projectRoot: "/other", canMutate: () => true }
  render(
    <MessageRenderProvider value={outer}>
      <MessageRenderProvider value={inner}>
        <Probe />
      </MessageRenderProvider>
    </MessageRenderProvider>
  )
  const context = seen.at(-1)!
  expect(context.onCopy).toBe(onCopy)
  expect(context.projectRoot).toBe("/other")
  expect(context.canMutate!("x", "edit")).toBe(false)
})

it("passes the parent through for an empty value, so nothing below re-renders", () => {
  const { seen, Probe } = capture()
  const outer = { projectRoot: "/repo" }
  const empty = {}
  const { rerender } = render(
    <MessageRenderProvider value={outer}>
      <MessageRenderProvider value={empty}>
        <Probe />
      </MessageRenderProvider>
    </MessageRenderProvider>
  )
  rerender(
    <MessageRenderProvider value={outer}>
      <MessageRenderProvider value={{}}>
        <Probe />
      </MessageRenderProvider>
    </MessageRenderProvider>
  )
  expect(seen[0]).toBe(seen.at(-1))
  expect(seen[0]).toBe(outer)
})
