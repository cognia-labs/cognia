import { installSidebarGestureRunner, runSidebarGesture } from "./sidebar-gesture"

afterEach(() => installSidebarGestureRunner(null))

describe("sidebar gesture seam", () => {
  it("applies a gesture at once when no runner is installed", () => {
    const apply = jest.fn()
    runSidebarGesture(apply, 0)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it("hands the gesture and its target width to the installed runner", () => {
    const runner = jest.fn()
    installSidebarGestureRunner(runner)
    const apply = jest.fn()
    runSidebarGesture(apply, 256)
    expect(runner).toHaveBeenCalledWith(apply, 256)
    expect(apply).not.toHaveBeenCalled()
  })

  it("goes back to applying at once when the runner is removed", () => {
    installSidebarGestureRunner(jest.fn())
    installSidebarGestureRunner(null)
    const apply = jest.fn()
    runSidebarGesture(apply, 0)
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
