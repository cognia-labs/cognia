/**
 * @jest-environment jsdom
 */

import { fireEvent, render } from "@testing-library/react"
import { useState, type ReactNode } from "react"

import { useSettingsStore } from "@/stores/settings/settings-store"

import { EntranceMotionProvider, MotionReveal, ReadingCollapse } from "./motion-reveal"

// The shared `motion/react` mock drops `initial`, which is exactly what these
// tests are about, so this suite records the props each motion element gets.
const mockMotionProps: Array<Record<string, unknown>> = []
jest.mock("motion/react", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const motionDiv = React.forwardRef(function MotionDiv(
    props: Record<string, unknown> & { children?: ReactNode },
    ref: React.Ref<HTMLDivElement>
  ) {
    mockMotionProps.push(props)
    return React.createElement("div", { ref, className: props.className }, props.children)
  })
  return {
    motion: { div: motionDiv },
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    useReducedMotion: () => false,
  }
})

function lastInitial() {
  return mockMotionProps.at(-1)?.initial
}

beforeEach(() => {
  mockMotionProps.length = 0
  useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
})

describe("MotionReveal entrance", () => {
  it("plays outside any transcript, and for content that is arriving", () => {
    render(<MotionReveal>row</MotionReveal>)
    expect(lastInitial()).toEqual({ opacity: 0, y: 3 })

    render(
      <EntranceMotionProvider arriving>
        <MotionReveal>row</MotionReveal>
      </EntranceMotionProvider>
    )
    expect(lastInitial()).toEqual({ opacity: 0, y: 3 })
  })

  it("does not play for history mounting or remounting", () => {
    render(
      <EntranceMotionProvider arriving={false}>
        <MotionReveal>row</MotionReveal>
      </EntranceMotionProvider>
    )
    expect(lastInitial()).toBe(false)
  })

  it("keeps the decision made at mount when the message seals", () => {
    const view = render(
      <EntranceMotionProvider arriving>
        <MotionReveal>row</MotionReveal>
      </EntranceMotionProvider>
    )
    view.rerender(
      <EntranceMotionProvider arriving={false}>
        <MotionReveal>row</MotionReveal>
      </EntranceMotionProvider>
    )
    expect(lastInitial()).toEqual({ opacity: 0, y: 3 })
  })
})

describe("ReadingCollapse entrance", () => {
  function Disclosure({ startOpen }: { startOpen: boolean }) {
    const [open, setOpen] = useState(startOpen)
    return (
      <>
        <button onClick={() => setOpen((value) => !value)}>toggle</button>
        <ReadingCollapse open={open}>body</ReadingCollapse>
      </>
    )
  }

  it("does not fade a body that is already open at mount", () => {
    render(<Disclosure startOpen />)
    expect(lastInitial()).toBe(false)
  })

  it("fades a body opened after mount, including a reopen", () => {
    const view = render(<Disclosure startOpen />)
    fireEvent.click(view.getByText("toggle"))
    fireEvent.click(view.getByText("toggle"))
    expect(lastInitial()).toEqual({ opacity: 0, y: -2 })

    const closed = render(<Disclosure startOpen={false} />)
    fireEvent.click(closed.getAllByText("toggle")[1]!)
    expect(lastInitial()).toEqual({ opacity: 0, y: -2 })
  })
})
