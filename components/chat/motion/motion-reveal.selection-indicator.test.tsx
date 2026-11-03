/**
 * @jest-environment jsdom
 */
// jsdom has no layout, so motion never measures there and the cost this guards
// against (a forced full-page layout each time a mounted `layoutId` element
// renders) cannot be observed directly. Pin the mechanism instead: a host
// re-render with unchanged props must not reach the motion element at all.
import { render } from "@testing-library/react"

let motionSpanRenders = 0

jest.mock("motion/react", () => {
  const actual = jest.requireActual("motion/react")
  return {
    ...actual,
    motion: new Proxy(actual.motion, {
      get(target, key) {
        if (key !== "span") return target[key as keyof typeof target]
        return function MotionSpanProbe(props: { className?: string; layoutId?: string }) {
          motionSpanRenders += 1
          return <span aria-hidden data-layout-id={props.layoutId} className={props.className} />
        }
      },
    }),
  }
})

import { MotionSelectionIndicator } from "./motion-reveal"
import { useSettingsStore } from "@/stores/settings/settings-store"

function Host({
  tick,
  active = true,
  tint = "tint",
}: {
  tick: number
  active?: boolean
  tint?: string
}) {
  return (
    <button type="button" data-tick={tick}>
      <MotionSelectionIndicator groupId="guild-rail-selection" active={active} className={tint} />
    </button>
  )
}

describe("MotionSelectionIndicator re-renders", () => {
  beforeEach(() => {
    motionSpanRenders = 0
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 1 } } as never })
  })

  it("skips the motion element when its host re-renders with the same props", () => {
    const { rerender, container } = render(<Host tick={0} />)
    expect(container.querySelector("[data-layout-id]")).toHaveAttribute(
      "data-layout-id",
      "guild-rail-selection"
    )
    for (let tick = 1; tick <= 10; tick += 1) rerender(<Host tick={tick} />)
    expect(motionSpanRenders).toBe(1)
  })

  it("still renders when the indicator's own props change", () => {
    const { rerender, container } = render(<Host tick={0} />)
    rerender(<Host tick={1} tint="tint other" />)
    expect(motionSpanRenders).toBe(2)

    rerender(<Host tick={2} active={false} tint="tint other" />)
    expect(container.querySelector("[data-layout-id]")).toBeNull()
  })
})
