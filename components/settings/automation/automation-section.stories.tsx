import type { Meta, StoryObj } from "@storybook/nextjs"

import { AutomationSection } from "./automation-section"

// Status strip over a master/detail pane (Overview / Permissions / Access rules /
// Behavior / Audit / Inspector / Diagnostics), driven by the `?autoTab=` query
// param via the App Router mocks the Storybook preview supplies. The automation
// engine only runs under Tauri, so in the browser the section renders its
// header and the "runs on the desktop app" notice.
const meta = {
  title: "Settings/Automation/AutomationSection",
  component: AutomationSection,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AutomationSection>

export default meta
type Story = StoryObj<typeof meta>

// Web branch: header + unavailable notice.
export const Default: Story = {}
