import type { Meta, StoryObj } from "@storybook/nextjs"
import { BotRuntimeNotice, type BotRuntimeNoticeProps } from "./bot-runtime-notice"

const meta = {
  title: "Bots/RuntimeNotice",
  component: BotRuntimeNotice,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "The real unpaired-browser no-host path. Existing Bots are shown as unable to execute; an empty installation list gets informational guidance. No fake Tauri/paired globals or runtime executor is mounted. Native/paired acceptance stays outside Storybook.",
      },
    },
  },
  args: { hasBots: true },
  argTypes: {
    hasBots: {
      control: "boolean",
      description: "Whether installed Bots would be stranded without a host.",
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[36rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BotRuntimeNotice>
export default meta
type Story = StoryObj<BotRuntimeNoticeProps>
export const HostUnavailable: Story = {}
export const NoInstallations: Story = { args: { hasBots: false } }
