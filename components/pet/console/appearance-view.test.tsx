import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/components/pet/settings/pet-customization-workspace", () => ({
  PetCustomizationWorkspace: () => (
    <div data-testid="pet-customization-workspace">
      <div data-setting-id="pet-look" />
    </div>
  ),
}))
const bindingProps = jest.fn()
jest.mock("./binding-tab", () => ({
  BindingTab: (props: unknown) => {
    bindingProps(props)
    return <div data-testid="binding-tab" />
  },
}))
let desktopProfile = true
jest.mock("@/components/platform/capability-gate", () => ({
  CapabilityGate: ({ children }: { children: React.ReactNode }) =>
    desktopProfile ? <>{children}</> : null,
}))

import { AppearanceView, PET_BINDING_SECTION_ID } from "./appearance-view"

const scrollIntoView = jest.fn()
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})
beforeEach(() => {
  scrollIntoView.mockClear()
  bindingProps.mockClear()
  desktopProfile = true
})

describe("AppearanceView", () => {
  it("holds the customization workspace and the character binding", () => {
    render(<AppearanceView canCustomize canEditBinding />)
    expect(screen.getByTestId("pet-customization-workspace")).toBeInTheDocument()
    expect(screen.getByTestId("binding-tab")).toBeInTheDocument()
    expect(bindingProps).toHaveBeenLastCalledWith({ readOnly: false })
  })

  it("indexes the sections and scrolls to one", () => {
    render(<AppearanceView canCustomize canEditBinding />)
    const index = screen.getByTestId("pet-appearance-index")
    const targets = Array.from(index.querySelectorAll("[data-index-target]")).map((el) =>
      el.getAttribute("data-index-target")
    )
    expect(targets[0]).toBe("pet-enabled")
    expect(targets).toContain("pet-desktop")
    expect(targets.at(-1)).toBe(PET_BINDING_SECTION_ID)
    fireEvent.click(index.querySelector('[data-index-target="pet-look"]') as Element)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it("leaves the desktop window section out of the index off the desktop shell", () => {
    desktopProfile = false
    render(<AppearanceView canCustomize canEditBinding />)
    expect(document.querySelector('[data-index-target="pet-desktop"]')).toBeNull()
  })

  it("lands a binding link on the binding section", () => {
    render(<AppearanceView canCustomize canEditBinding focus="binding" />)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    const scrolled = scrollIntoView.mock.instances[0] as unknown as HTMLElement
    expect(scrolled).toHaveAttribute("data-setting-id", PET_BINDING_SECTION_ID)
  })

  it("puts the desktop-only notice in place of the workspace on a paired phone", () => {
    render(<AppearanceView canCustomize={false} canEditBinding={false} />)
    expect(screen.queryByTestId("pet-customization-workspace")).toBeNull()
    expect(screen.getByTestId("pet-desktop-only-notice")).toHaveAttribute("data-tab", "appearance")
    expect(screen.queryByTestId("pet-appearance-index")).toBeNull()
    // The binding still reads, read-only.
    expect(bindingProps).toHaveBeenLastCalledWith({ readOnly: true })
  })
})
