import { NativeTouchAdapter, NativeTouchControls } from "./native-touch-controls"
import { KEYSYM } from "@cognia/plugin-ui"
import { fireEvent, render, screen } from "@testing-library/react"

test("native controls default to trackpad, scroll immediately and switch to direct drag", () => {
  const surface = document.createElement("canvas")
  surface.getBoundingClientRect = () => ({
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
  const input = jest.fn()
  render(
    <NativeTouchControls
      surface={() => surface}
      width={800}
      height={600}
      labels={(key) => key}
      input={input}
    />
  )
  expect(screen.getByRole("button", { name: "touch.switchToDirect" })).toBeInTheDocument()
  const pointer = (type: string, id: number, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
    Object.defineProperty(event, "pointerId", { value: id })
    fireEvent(screen.getByLabelText("touch.surfaceLabel"), event)
  }
  pointer("pointerdown", 1, 10, 10)
  pointer("pointerdown", 2, 30, 10)
  pointer("pointermove", 1, 10, 40)
  pointer("pointerup", 1, 10, 40)
  pointer("pointerup", 2, 30, 10)
  expect(input).toHaveBeenLastCalledWith(
    { kind: "scroll", opts: { dx: 0, dy: -15 } },
    { x: 400, y: 300 }
  )
  fireEvent.click(screen.getByRole("button", { name: "touch.switchToDirect" }))
  expect(screen.getByRole("button", { name: "touch.switchToTrackpad" })).toBeInTheDocument()
  pointer("pointerdown", 3, 100, 50)
  pointer("pointermove", 3, 150, 60)
  pointer("pointerup", 3, 150, 60)
  expect(input).toHaveBeenLastCalledWith(
    { kind: "drag", to: { x: 300, y: 120 }, opts: { button: "left" } },
    { x: 200, y: 100 }
  )
})

describe("native touch UiAction adapter", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())
  const geometry = () => ({ width: 800, height: 600, displayWidth: 400, displayHeight: 300 })
  function setup() {
    const send = jest.fn()
    return { send, adapter: new NativeTouchAdapter(geometry, send) }
  }
  it("maps a tap and double tap to click counts without held input", () => {
    const { send, adapter } = setup()
    adapter.pointer({ x: 10, y: 20 }, 1)
    adapter.pointer({ x: 10, y: 20 }, 0)
    jest.advanceTimersByTime(301)
    expect(send).toHaveBeenLastCalledWith(
      { kind: "click", button: "left", count: 1 },
      { x: 20, y: 40 }
    )
    send.mockClear()
    for (let i = 0; i < 2; i++) {
      adapter.pointer({ x: 10, y: 20 }, 1)
      adapter.pointer({ x: 10, y: 20 }, 0)
    }
    jest.advanceTimersByTime(301)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ kind: "click", button: "left", count: 2 }, { x: 20, y: 40 })
  })
  it("maps movement under a button to one drag and long press to right click", () => {
    const { send, adapter } = setup()
    adapter.pointer({ x: 10, y: 20 }, 1, true)
    adapter.pointer({ x: 40, y: 50 }, 1)
    expect(send).not.toHaveBeenCalled()
    adapter.pointer({ x: 40, y: 50 }, 0)
    expect(send).toHaveBeenLastCalledWith(
      { kind: "drag", to: { x: 80, y: 100 }, opts: { button: "left" } },
      { x: 20, y: 40 }
    )
    adapter.pointer({ x: 10, y: 20 }, 1, true)
    adapter.pointer({ x: 10, y: 20 }, 0)
    expect(send).toHaveBeenLastCalledWith(
      { kind: "click", button: "right", count: 1 },
      { x: 20, y: 40 }
    )
  })
  it("cancels a direct-touch press when a second finger starts scrolling", () => {
    const { send, adapter } = setup()
    adapter.pointer({ x: 10, y: 20 }, 1)
    adapter.cancel()
    adapter.pointer({ x: 10, y: 20 }, 0)
    adapter.scroll({ x: 10, y: 20 }, 15)
    jest.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ kind: "scroll", opts: { dx: 0, dy: 15 } }, { x: 20, y: 40 })
  })
  it("emits chords and composed text using the local viewer vocabulary", () => {
    const { send, adapter } = setup()
    adapter.sendKey(KEYSYM.Control_L, true)
    adapter.sendKey(KEYSYM.Tab, true)
    adapter.sendKey(KEYSYM.Tab, false)
    adapter.sendKey(KEYSYM.Control_L, false)
    expect(send).toHaveBeenLastCalledWith({ kind: "pressKey", chord: "ctrl+Tab" }, null)
    adapter.sendText("你好", [])
    expect(send).toHaveBeenLastCalledWith({ kind: "typeText", text: "你好" }, null)
  })
  it("discards pending taps when control is released", () => {
    const { send, adapter } = setup()
    adapter.pointer({ x: 10, y: 20 }, 1)
    adapter.pointer({ x: 10, y: 20 }, 0)
    adapter.cancel()
    jest.runAllTimers()
    expect(send).not.toHaveBeenCalled()
  })
})
