/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"

import { AutomationNav } from "./automation-nav"
import { AUTOMATION_NAV_GROUPS, AUTOMATION_NAV_ITEMS } from "./nav-config"

describe("AutomationNav", () => {
  it("labels every group and panel from the automation namespace", () => {
    render(
      <AutomationNav groups={AUTOMATION_NAV_GROUPS} activeId="overview" onSelect={jest.fn()} />
    )
    for (const group of AUTOMATION_NAV_GROUPS) {
      expect(screen.getByText(en.automation.nav.groups[group.id])).toBeInTheDocument()
    }
    for (const item of AUTOMATION_NAV_ITEMS) {
      expect(screen.getAllByText(en.automation.nav.items[item.id].label).length).toBeGreaterThan(0)
    }
  })

  it("reports the selected panel", async () => {
    const onSelect = jest.fn()
    render(<AutomationNav groups={AUTOMATION_NAV_GROUPS} activeId="overview" onSelect={onSelect} />)
    await userEvent.click(screen.getByText(en.automation.nav.items.audit.label))
    expect(onSelect).toHaveBeenCalledWith("audit")
  })
})
