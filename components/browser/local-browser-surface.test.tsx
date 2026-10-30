/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { createRef } from "react"
import { LocalBrowserCanvas, useFrameCanvas } from "./local-browser-surface"
import { localBrowser } from "@/lib/browser/local-client"
jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: { rpc: jest.fn(async () => undefined) },
}))
function Surface({ pageId = "page" }: { pageId?: string }) {
  const canvas = useFrameCanvas()
  return (
    <LocalBrowserCanvas canvas={canvas} sessionId="viewer" pageId={pageId} ready label="Document" />
  )
}
beforeEach(() => jest.clearAllMocks())
it("targets native pointer, wheel and key input at the supplied isolated page", async () => {
  render(<Surface />)
  const canvas = screen.getByRole("application", { name: "Document" })
  await act(async () => {
    fireEvent.pointerDown(canvas, { button: 0 })
    fireEvent.pointerUp(canvas, { button: 0 })
    fireEvent.wheel(canvas, { deltaY: 20 })
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" })
    fireEvent.keyUp(canvas, { key: "a", code: "KeyA" })
  })
  expect(
    jest
      .mocked(localBrowser.rpc)
      .mock.calls.map(([, payload]) => [
        payload?.sessionId,
        payload?.pageId,
        (payload?.input as { payload: { type: string } }).payload.type,
      ])
  ).toEqual([
    ["viewer", "page", "mousePressed"],
    ["viewer", "page", "mouseReleased"],
    ["viewer", "page", "mouseWheel"],
    ["viewer", "page", "keyDown"],
    ["viewer", "page", "keyUp"],
  ])
})
it("commits IME text once without forwarding composing keystrokes", async () => {
  render(<Surface />)
  const canvas = screen.getByRole("application", { name: "Document" })
  await act(async () => {
    fireEvent.compositionStart(canvas)
    fireEvent.keyDown(canvas, { key: "Process", keyCode: 229 })
    fireEvent.compositionEnd(canvas, { data: "文档" })
  })
  expect(localBrowser.rpc).toHaveBeenCalledTimes(1)
  expect(localBrowser.rpc).toHaveBeenCalledWith("browser.input", {
    sessionId: "viewer",
    pageId: "page",
    input: { kind: "key", payload: { type: "char", text: "文档" } },
  })
})
it("attaches and clears the supplied canvas ref across replacement and unmount", () => {
  const first = createRef<HTMLCanvasElement>()
  const second = createRef<HTMLCanvasElement>()
  const canvas = {
    canvasRef: first,
    frameSizeRef: { current: { width: 1, height: 1 } },
    drawFrame: jest.fn(),
    resetPage: jest.fn(),
    requestViewport: jest.fn(),
    applyViewport: jest.fn(),
  }
  const { rerender, unmount } = render(
    <LocalBrowserCanvas canvas={canvas} sessionId="viewer" ready label="Document" />
  )
  const element = screen.getByRole("application", { name: "Document" })
  expect(first.current).toBe(element)
  rerender(
    <LocalBrowserCanvas
      canvas={{ ...canvas, canvasRef: second }}
      sessionId="viewer"
      ready
      label="Document"
    />
  )
  expect(first.current).toBeNull()
  expect(second.current).toBe(element)
  unmount()
  expect(second.current).toBeNull()
})
