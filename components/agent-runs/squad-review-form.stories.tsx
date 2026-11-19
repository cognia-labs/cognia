import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"
import { SquadReviewForm } from "./squad-review-form"

const meta = {
  title: "Agent Runs/ReviewForm",
  component: SquadReviewForm,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Typed review-form snapshots for synthetic interrupts. Decisions call a spy, never an execution command. Budget/host input validation is real; these examples grant no run authority and contact no host or model.",
      },
    },
  },
  args: {
    interrupt: { id: "storybook-review", reviewKind: "plan", expiresAt: 1_700_000_000_000 },
    onDecide: fn(),
  },
  argTypes: { busy: { control: "boolean" }, interrupt: { control: "object" } },
  decorators: [
    (Story) => (
      <div className="w-[36rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SquadReviewForm>
export default meta
type Story = StoryObj<typeof meta>
export const Plan: Story = {}
export const Budget: Story = {
  args: {
    interrupt: {
      id: "storybook-budget",
      reviewKind: "budget_extension",
      expiresAt: 1_700_000_000_000,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const amount = canvas.getByRole("spinbutton")
    await userEvent.clear(amount)
    await userEvent.type(amount, "0")
    await expect(canvas.getAllByRole("button")[0]).toBeDisabled()
  },
}
export const CapabilityAudit: Story = {
  args: {
    interrupt: {
      id: "storybook-audit",
      reviewKind: "capability_audit",
      expiresAt: 1_700_000_000_000,
      subject: { missingCapabilities: ["example:network"] },
    },
  },
}
export const RecoveryHostRequired: Story = {
  args: {
    interrupt: {
      id: "storybook-recovery",
      reviewKind: "team_recovery",
      expiresAt: 1_700_000_000_000,
      subject: {
        reason: "missing_checkpoint",
        choices: ["retry_host", "restart_run", "terminate"],
        uncertainChildIds: ["example-child"],
      },
    },
  },
}
export const Busy: Story = { args: { busy: true } }
