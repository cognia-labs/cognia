import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import { BotRowButton } from "./bot-row"

const row: BotConsoleRow = {
  id: "storybook-bot",
  definitionId: "example:review",
  source: "plugin",
  name: "Review Bot",
  executor: "handler",
  status: "enabled",
  scope: { kind: "account" },
  orphaned: false,
  problems: [],
  triggers: [{ id: "push", kind: "event", armed: true }],
  armedTriggers: 1,
  unboundSlots: [],
  requiredSlots: [],
  credentials: [],
  config: {},
  deadLetters: 0,
  updatedAt: 1_700_000_000_000,
}
const meta = {
  title: "Bots/Row",
  component: BotRowButton,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Pure Bot rail row with synthetic installation data. Selection calls a spy with the installation id; no Bot is installed, configured or executed. Attention, dead-letter and orphan indicators use production rendering.",
      },
    },
  },
  args: { row, selected: false, onSelect: fn() },
  argTypes: {
    selected: { control: "boolean" },
    row: {
      control: "object",
      description: "Synthetic BotConsoleRow; never an installed production Bot.",
    },
  },
  decorators: [
    (Story) => (
      <div className="w-80 max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BotRowButton>
export default meta
type Story = StoryObj<typeof meta>
export const Healthy: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button"))
    await expect(args.onSelect).toHaveBeenCalledWith(row.id)
  },
}
export const Selected: Story = { args: { selected: true } }
export const NoArmedTriggers: Story = {
  args: {
    row: { ...row, armedTriggers: 0, triggers: [{ id: "push", kind: "event", armed: false }] },
  },
}
export const DeadLetters: Story = { args: { row: { ...row, deadLetters: 3 } } }
export const Orphaned: Story = { args: { row: { ...row, orphaned: true, executor: undefined } } }
