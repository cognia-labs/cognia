import { fireEvent, render, screen, within } from "@testing-library/react"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { PET_CONSOLE_SECTIONS, type PetConsoleSection } from "@/lib/pet/console-tabs"
import { PET_CONSOLE_SECTION_ICONS, PetConsoleNav } from "./pet-console-nav"

const WITHOUT_PLUGINS = PET_CONSOLE_SECTIONS.filter((id) => id !== "plugins")

function Harness({
  sections = WITHOUT_PLUGINS,
  desktopOnlySections,
  onValueChange = () => {},
}: {
  sections?: readonly PetConsoleSection[]
  desktopOnlySections?: ReadonlySet<PetConsoleSection>
  onValueChange?: (value: string) => void
}) {
  return (
    <Tabs defaultValue="home" onValueChange={onValueChange}>
      <PetConsoleNav sections={sections} desktopOnlySections={desktopOnlySections} />
      {sections.map((id) => (
        <TabsContent key={id} value={id}>
          {id}
        </TabsContent>
      ))}
    </Tabs>
  )
}

describe("PetConsoleNav", () => {
  it("lists the five places in order, as one tablist", () => {
    render(<Harness />)
    const nav = screen.getByTestId("pet-console-nav")
    expect(nav).toHaveAttribute("role", "tablist")
    const tabs = within(nav).getAllByRole("tab")
    expect(tabs.map((tab) => tab.getAttribute("data-tab"))).toEqual([
      "home",
      "chat",
      "shop",
      "collection",
      "activity",
    ])
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Home",
      "Chat",
      "Shop",
      "Collection",
      "Activity",
    ])
  })

  it("has an icon for every section", () => {
    for (const id of PET_CONSOLE_SECTIONS) expect(PET_CONSOLE_SECTION_ICONS[id]).toBeDefined()
  })

  it("adds the plugins tab only when offered", () => {
    render(<Harness sections={PET_CONSOLE_SECTIONS} />)
    expect(document.querySelector('[data-tab="plugins"]')).not.toBeNull()
  })

  it("selects a tab and points it at its panel", () => {
    const onValueChange = jest.fn()
    render(<Harness onValueChange={onValueChange} />)
    const shop = screen.getByRole("tab", { name: "Shop" })
    // Radix tabs activate on mousedown.
    fireEvent.mouseDown(shop)
    expect(onValueChange).toHaveBeenCalledWith("shop")
    expect(shop).toHaveAttribute("aria-controls", screen.getByRole("tabpanel").id)
  })

  it("badges the desktop-only tabs and keeps them selectable", () => {
    render(
      <Harness
        sections={PET_CONSOLE_SECTIONS}
        desktopOnlySections={new Set<PetConsoleSection>(["plugins"])}
      />
    )
    const plugins = document.querySelector('[data-tab="plugins"]') as HTMLElement
    expect(plugins).toHaveAttribute("data-desktop-only", "true")
    expect(within(plugins).getByTestId("pet-console-desktop-badge")).toHaveTextContent("Desktop")
    expect(plugins).not.toBeDisabled()
    expect(screen.getAllByTestId("pet-console-desktop-badge")).toHaveLength(1)
  })
})
