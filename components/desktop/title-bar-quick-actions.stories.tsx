import type { Meta, StoryObj } from "@storybook/nextjs"

import { TitleBarQuickActions } from "./title-bar-quick-actions"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// Quick-actions cluster: the desktop-pet show / put-away toggle, OCR, and the
// capture entry point. The pet and capture buttons are desktop-shell only, so
// Storybook (a browser) shows the OCR button alone.
const meta = {
  title: "Desktop/TitleBar/QuickActions",
  component: TitleBarQuickActions,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStores(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="flex h-8 items-center bg-muted/40 text-xs">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TitleBarQuickActions>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
