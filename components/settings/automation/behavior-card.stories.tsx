import type { Meta, StoryObj } from "@storybook/nextjs"

import { SettingsStack } from "@/components/settings/common/settings-block"

import { AutomationSettingsProvider } from "./automation-settings-context"
import { BehaviorCard } from "./behavior-card"

// Reads the automation settings blob through the section's
// `AutomationSettingsProvider`, which only calls the host inside the desktop
// shell. In the Storybook browser there is no Rust backend, so `settings` stays
// null and the blocks render their loading skeleton — the model-behavior knobs
// appear once a backend resolves the blob under `pnpm tauri dev`.
const meta = {
  title: "Settings/Automation/BehaviorCard",
  component: BehaviorCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <AutomationSettingsProvider>
        <div className="w-[560px] max-w-full">
          <SettingsStack>
            <Story />
          </SettingsStack>
        </div>
      </AutomationSettingsProvider>
    ),
  ],
} satisfies Meta<typeof BehaviorCard>

export default meta
type Story = StoryObj<typeof meta>

// Web/no-backend branch — loading skeleton (settings unresolved).
export const Default: Story = {}
