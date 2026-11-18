/**
 * @jest-environment jsdom
 */
import {
  __resetDockTabFocusForTests,
  cancelDockTabFocus,
  isFocusableOnScreen,
  registerDockFocusReturn,
  requestDockTabFocus,
  returnFocusFromDock,
  takeDockTabFocus,
} from "./dock-tab-focus"

function button(parent: HTMLElement = document.body): HTMLButtonElement {
  const element = document.createElement("button")
  parent.appendChild(element)
  return element
}

beforeEach(() => {
  __resetDockTabFocusForTests()
  document.body.innerHTML = ""
  jest.useRealTimers()
})

describe("dock tab focus", () => {
  it("moves focus to the requested tab once a strip can show it", () => {
    const tab = button()
    requestDockTabFocus("scope", "artifact:a")
    expect(takeDockTabFocus("scope", (key) => (key === "artifact:a" ? tab : undefined))).toBe(true)
    expect(document.activeElement).toBe(tab)
    // Consumed: a later render does not steal focus again.
    button().focus()
    expect(takeDockTabFocus("scope", () => tab)).toBe(false)
  })

  it("leaves the request for the strip that is on screen", () => {
    const hidden = document.createElement("div")
    hidden.hidden = true
    document.body.appendChild(hidden)
    const behind = button(hidden)
    const front = button()
    requestDockTabFocus("scope", "artifact:a")
    expect(takeDockTabFocus("scope", () => behind)).toBe(false)
    expect(takeDockTabFocus("scope", () => front)).toBe(true)
    expect(document.activeElement).toBe(front)
  })

  it("ignores strips of another scope", () => {
    requestDockTabFocus("scope", "artifact:a")
    expect(takeDockTabFocus("other", () => button())).toBe(false)
  })

  it("expires a request nobody could honour", () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    requestDockTabFocus("scope", "artifact:a")
    jest.setSystemTime(5_000)
    expect(takeDockTabFocus("scope", () => button())).toBe(false)
  })

  it("can be cancelled", () => {
    requestDockTabFocus("scope", "artifact:a")
    cancelDockTabFocus()
    expect(takeDockTabFocus("scope", () => button())).toBe(false)
  })

  it("treats inert and detached elements as off screen", () => {
    const inert = document.createElement("div")
    inert.setAttribute("inert", "")
    document.body.appendChild(inert)
    expect(isFocusableOnScreen(button(inert))).toBe(false)
    expect(isFocusableOnScreen(document.createElement("button"))).toBe(false)
    expect(isFocusableOnScreen(button())).toBe(true)
  })

  it("returns focus to the most recent dock toggle on screen", () => {
    const first = button()
    const second = button()
    const disposeFirst = registerDockFocusReturn(first)
    const disposeSecond = registerDockFocusReturn(second)
    expect(returnFocusFromDock()).toBe(true)
    expect(document.activeElement).toBe(second)
    disposeSecond()
    expect(returnFocusFromDock()).toBe(true)
    expect(document.activeElement).toBe(first)
    disposeFirst()
    expect(returnFocusFromDock()).toBe(false)
  })
})
