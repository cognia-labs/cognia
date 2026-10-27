import { render, screen } from "@testing-library/react"

let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}))

const consoleProps = jest.fn()
jest.mock("@/components/pet/console/pet-console", () => ({
  PetConsole: (props: unknown) => {
    consoleProps(props)
    return <div data-testid="pet-console-stub" />
  },
}))

import PetPage from "./page"

beforeEach(() => {
  consoleProps.mockClear()
  searchParams = new URLSearchParams()
})

describe("PetPage", () => {
  it("renders the console with no initial target by default", () => {
    render(<PetPage />)
    expect(screen.getByTestId("pet-console-stub")).toBeInTheDocument()
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ initialTarget: undefined }))
  })

  it("resolves a ?tab= deep link and drops an invalid one", () => {
    searchParams = new URLSearchParams("tab=insights")
    render(<PetPage />)
    expect(consoleProps).toHaveBeenCalledWith(
      expect.objectContaining({
        initialTarget: { view: "main", section: "activity", segment: "insights" },
      })
    )

    consoleProps.mockClear()
    searchParams = new URLSearchParams("tab=not-a-tab")
    render(<PetPage />)
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ initialTarget: undefined }))
  })

  it("opens the appearance sub-page from ?view= and from a legacy ?tab=", () => {
    searchParams = new URLSearchParams("view=appearance")
    render(<PetPage />)
    expect(consoleProps).toHaveBeenLastCalledWith({ initialTarget: { view: "appearance" } })

    searchParams = new URLSearchParams("tab=binding")
    render(<PetPage />)
    expect(consoleProps).toHaveBeenLastCalledWith({
      initialTarget: { view: "appearance", focus: "binding" },
    })
  })
})
