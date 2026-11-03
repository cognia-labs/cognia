import { fireEvent, render, screen, within } from "@testing-library/react"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { PET_CONSOLE_SECTIONS, type PetConsoleSection } from "@/lib/pet/console-tabs"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { PET_CONSOLE_SECTION_ICONS, usePetConsoleTabs } from "./pet-console-nav"

const WITHOUT_PLUGINS = PET_CONSOLE_SECTIONS.filter((id) => id !== "plugins")

function Places({
  sections,
  desktopOnlySections,
  value,
}: {
  sections: readonly PetConsoleSection[]
  desktopOnlySections?: ReadonlySet<PetConsoleSection>
  value: PetConsoleSection
}) {
  const tabs = usePetConsoleTabs({ sections, desktopOnlySections, value })
  return <FeaturePageHeader title="Boba" description="A pet" icon={<span />} tabs={tabs} />
}

function Harness({
  sections = WITHOUT_PLUGINS,
  desktopOnlySections,
  onValueChange = () => {},
}: {
  sections?: readonly PetConsoleSection[]
  desktopOnlySections?: ReadonlySet<PetConsoleSection>
  onValueChange?: (value: string) => void
}) {
  // The console owns the root and the panels; the header draws the list.
  return (
    <Tabs defaultValue="home" onValueChange={onValueChange}>
      <Places sections={sections} desktopOnlySections={desktopOnlySections} value="home" />
      {sections.map((id) => (
        <TabsContent key={id} value={id}>
          {id}
        </TabsContent>
      ))}
    </Tabs>
  )
}

describe("usePetConsoleTabs", () => {
  it("lists the five places in order, as the header's one underline tablist", () => {
    render(<Harness />)
    const nav = screen.getByTestId("pet-console-nav")
    expect(nav).toHaveAttribute("role", "tablist")
    expect(nav).toHaveAttribute("data-variant", "line")
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
    expect(plugins).toHaveAttribute("data-badged", "true")
    expect(within(plugins).getByTestId("feature-header-tab-badge")).toHaveTextContent("Desktop")
    expect(plugins).not.toBeDisabled()
    expect(screen.getAllByTestId("feature-header-tab-badge")).toHaveLength(1)
  })
})
