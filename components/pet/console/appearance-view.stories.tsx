import type { Meta, StoryObj } from "@storybook/nextjs"

import { AppearanceView } from "./appearance-view"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"

// The `/pet` console's "Appearance & settings" sub-page: the shared pet
// customization workspace (the same one Settings → Pet points to) plus the
// per-character binding, with a section index on a wide pane. On a paired
// phone the workspace is replaced by the desktop-only notice and the binding
// is read-only.
const meta = {
  title: "Pet/Console/AppearanceView",
  component: AppearanceView,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  args: { canCustomize: true, canEditBinding: true },
  decorators: [
    (Story) => (
      <div className="@container/pet-pane p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AppearanceView>

export default meta
type Story = StoryObj<typeof meta>

export const Desktop: Story = {}

export const PairedPhone: Story = {
  args: { canCustomize: false, canEditBinding: false },
}
