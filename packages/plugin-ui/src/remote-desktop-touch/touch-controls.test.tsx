import { fireEvent, render, screen } from "@testing-library/react"
import { TouchKeyBar, TouchTrackpadLayer, type TouchLabelKey } from "./touch-controls"
import { KEYSYM } from "./touch-input"

test("the first two-finger pan scrolls at the initial cursor without sending a click", () => {
  const canvas = document.createElement("canvas")
  canvas.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  })
  const sink = { pointer: jest.fn(), scroll: jest.fn(), cancel: jest.fn() }
  render(<TouchTrackpadLayer canvas={() => canvas} labels={(key) => key} sink={sink} />)
  const surface = screen.getByLabelText("touch.surfaceLabel")
  const pointer = (type: string, id: number, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
    Object.defineProperty(event, "pointerId", { value: id })
    fireEvent(surface, event)
  }
  pointer("pointerdown", 1, 10, 10)
  pointer("pointerdown", 2, 30, 10)
  pointer("pointermove", 1, 10, 40)
  pointer("pointerup", 1, 10, 40)
  pointer("pointerup", 2, 30, 10)
  expect(sink.scroll).toHaveBeenCalledWith({ x: 200, y: 150 }, -15)
  expect(sink.pointer).not.toHaveBeenCalled()
})

test("labels are supplied by the consumer and the key bar keeps its independent sink", () => {
  const sendKey = jest.fn()
  const sendText = jest.fn()
  const mode = jest.fn()
  render(
    <TouchKeyBar
      labels={(key: TouchLabelKey) => key}
      sendKey={sendKey}
      sendText={sendText}
      sendCtrlAltDel={jest.fn()}
      inputMode="trackpad"
      onInputModeChange={mode}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "keys.tab" }))
  expect(sendKey).toHaveBeenNthCalledWith(1, KEYSYM.Tab, true)
  expect(sendKey).toHaveBeenNthCalledWith(2, KEYSYM.Tab, false)
  fireEvent.compositionEnd(screen.getByRole("textbox", { name: "keys.keyboardInput" }), {
    data: "你好",
  })
  expect(sendText).toHaveBeenCalledWith("你好", [])
  fireEvent.click(screen.getByRole("button", { name: "touch.switchToDirect" }))
  expect(mode).toHaveBeenCalledWith("direct")
})
