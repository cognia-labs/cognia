import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

import { PET_CONSOLE_SECTIONS } from "@/lib/pet/console-tabs"
import {
  PET_CONSOLE_PLACE_ICONS,
  PetConsoleNav,
  petConsoleNavGroups,
  type PetConsolePlace,
} from "./pet-console-nav"

const WITHOUT_PLUGINS = PET_CONSOLE_SECTIONS.filter((id) => id !== "plugins")

const rowIds = () =>
  within(screen.getByRole("list", { name: "Pet navigation" }))
    .getAllByRole("button")
    .map((row) => row.dataset.testid?.replace("pet-console-nav-item-", ""))

describe("petConsoleNavGroups", () => {
  it("puts the places under Your pet and Appearance & settings under Setup", () => {
    const groups = petConsoleNavGroups(WITHOUT_PLUGINS)
    expect(groups.map((group) => group.id)).toEqual(["pet", "setup"])
    expect(groups[0].items.map((item) => item.id)).toEqual(WITHOUT_PLUGINS)
    expect(groups[1].items.map((item) => item.id)).toEqual(["appearance"])
  })

  it("gives every place its own glyph", () => {
    const places = Object.keys(PET_CONSOLE_PLACE_ICONS) as PetConsolePlace[]
    expect(new Set(places.map((id) => PET_CONSOLE_PLACE_ICONS[id])).size).toBe(places.length)
  })
})

describe("PetConsoleNav", () => {
  it("lists the five places, then Appearance & settings, with labels and descriptions", () => {
    render(<PetConsoleNav sections={WITHOUT_PLUGINS} activeId="home" onSelect={jest.fn()} />)
    expect(rowIds()).toEqual(["home", "chat", "shop", "collection", "activity", "appearance"])
    expect(screen.getByTestId("pet-console-nav-group-pet")).toHaveTextContent("Your pet")
    expect(screen.getByTestId("pet-console-nav-group-setup")).toHaveTextContent("Setup")
    const shop = screen.getByTestId("pet-console-nav-item-shop")
    expect(shop).toHaveTextContent("Shop")
    expect(shop).toHaveTextContent("Spend coins on food and toys")
    expect(screen.getByTestId("pet-console-nav-item-appearance")).toHaveTextContent(
      "Appearance & settings"
    )
  })

  it("adds Extensions after the places while something fills it", () => {
    render(<PetConsoleNav sections={PET_CONSOLE_SECTIONS} activeId="home" onSelect={jest.fn()} />)
    expect(rowIds()).toEqual([
      "home",
      "chat",
      "shop",
      "collection",
      "activity",
      "plugins",
      "appearance",
    ])
  })

  it("marks the open place and reports a pick", () => {
    const onSelect = jest.fn()
    render(<PetConsoleNav sections={WITHOUT_PLUGINS} activeId="chat" onSelect={onSelect} />)
    expect(screen.getByTestId("pet-console-nav-item-chat")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("pet-console-nav-item-home")).not.toHaveAttribute("aria-current")
    fireEvent.click(screen.getByTestId("pet-console-nav-item-appearance"))
    expect(onSelect).toHaveBeenCalledWith("appearance")
  })

  it("badges only the places that run on the desktop, still selectable", () => {
    const onSelect = jest.fn()
    render(
      <PetConsoleNav
        sections={PET_CONSOLE_SECTIONS}
        activeId="home"
        onSelect={onSelect}
        desktopOnly={new Set<PetConsolePlace>(["plugins", "appearance"])}
      />
    )
    for (const id of ["plugins", "appearance"]) {
      const badge = screen.getByTestId(`pet-console-nav-badge-${id}`)
      expect(badge).toHaveTextContent("Desktop")
      expect(badge).toHaveAttribute("aria-label", "Runs only on your desktop")
    }
    for (const id of WITHOUT_PLUGINS) {
      expect(screen.queryByTestId(`pet-console-nav-badge-${id}`)).toBeNull()
    }
    fireEvent.click(screen.getByTestId("pet-console-nav-item-plugins"))
    expect(onSelect).toHaveBeenCalledWith("plugins")
  })

  it("keeps the rail's and the sheet's test ids apart", () => {
    render(
      <PetConsoleNav
        sections={WITHOUT_PLUGINS}
        activeId="home"
        onSelect={jest.fn()}
        idPrefix="pet-console-sheet"
      />
    )
    expect(screen.getByTestId("pet-console-sheet-nav-item-home")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-console-nav-item-home")).toBeNull()
  })
})
