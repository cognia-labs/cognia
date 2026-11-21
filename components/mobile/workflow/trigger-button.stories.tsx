import type { Meta, StoryObj } from "@storybook/nextjs"

import { TriggerButton } from "./trigger-button"

// Library Run button. Pure props — tapping runs the published workflow through
// `useLibraryRun` (queued to a paired Host, or run here standalone) + a haptic
// (no-ops off the Capacitor shell), so the static render is the meaningful surface.
const meta = {
  title: "Mobile/Workflow/TriggerButton",
  component: TriggerButton,
  parameters: { layout: "centered" },
  args: { workflow: { id: "wf-daily", name: "Daily standup digest" } },
} satisfies Meta<typeof TriggerButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const FullWidth: Story = {
  args: { className: "w-full" },
  decorators: [
    (Story) => (
      <div className="w-[280px]">
        <Story />
      </div>
    ),
  ],
}
