import { render, screen } from "@testing-library/react"

const mockError = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { ui: { error: (...args: unknown[]) => mockError(...args) } },
}))

import { ModuleBoundary } from "./module-boundary"

function Boom(): never {
  throw new Error("boom")
}

beforeEach(() => {
  mockError.mockClear()
  jest.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("ModuleBoundary", () => {
  it("renders its children while they work", () => {
    render(
      <ModuleBoundary module="radar" part="slot:pet.console.tab">
        <span>radar tab</span>
      </ModuleBoundary>
    )
    expect(screen.getByText("radar tab")).toBeInTheDocument()
    expect(mockError).not.toHaveBeenCalled()
  })

  it("renders nothing in place of a failed contribution and keeps its siblings", () => {
    render(
      <div>
        <ModuleBoundary module="radar" part="slot:pet.console.tab">
          <Boom />
        </ModuleBoundary>
        <span>sibling</span>
      </div>
    )
    expect(screen.getByText("sibling")).toBeInTheDocument()
    expect(mockError).toHaveBeenCalledWith(
      "module radar slot:pet.console.tab failed",
      expect.objectContaining({ message: "boom" }),
      expect.objectContaining({ componentStack: expect.any(String) })
    )
  })
})
