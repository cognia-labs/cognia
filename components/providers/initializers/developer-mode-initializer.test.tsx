import { render } from "@testing-library/react"

jest.mock("@/lib/plugin/devtools/developer-mode", () => ({
  applyBootDeveloperMode: jest.fn(() => false),
}))

import { DeveloperModeInitializer } from "./developer-mode-initializer"
import { applyBootDeveloperMode } from "@/lib/plugin/devtools/developer-mode"

const apply = applyBootDeveloperMode as jest.Mock

beforeEach(() => {
  apply.mockClear()
})

describe("DeveloperModeInitializer", () => {
  it("applies the boot value once on mount", () => {
    render(<DeveloperModeInitializer />)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it("renders nothing", () => {
    const { container } = render(<DeveloperModeInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("does not re-run on re-render", () => {
    const { rerender } = render(<DeveloperModeInitializer />)
    rerender(<DeveloperModeInitializer />)
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
