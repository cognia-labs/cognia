import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { expect, fn, userEvent, within } from "storybook/test"
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./confirmation"

const meta = {
  title: "AI Elements/Confirmation",
  component: Confirmation,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Approval-request rendering only. The approval id is synthetic and button callbacks are spies; approving this preview cannot grant a production capability. Requested, accepted and rejected states are explicit snapshots.",
      },
    },
  },
  args: { approval: { id: "storybook-approval" }, state: "approval-requested" },
  argTypes: {
    state: {
      control: "select",
      options: ["approval-requested", "approval-responded", "output-denied"],
    },
  },
  render: function Example(args) {
    const t = useTranslations("common")
    return (
      <div className="w-96 max-w-full">
        <Confirmation {...args}>
          <ConfirmationTitle>
            <ConfirmationRequest>{t("confirm")}</ConfirmationRequest>
            <ConfirmationAccepted>{t("yes")}</ConfirmationAccepted>
            <ConfirmationRejected>{t("no")}</ConfirmationRejected>
          </ConfirmationTitle>
          <ConfirmationActions>
            <ConfirmationAction onClick={decision}>{t("confirm")}</ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      </div>
    )
  },
} satisfies Meta<typeof Confirmation>
const decision = fn()
export default meta
type Story = StoryObj<typeof meta>
export const Requested: Story = {
  beforeEach: () => {
    decision.mockClear()
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button"))
    await expect(decision).toHaveBeenCalledTimes(1)
  },
}
export const Accepted: Story = {
  args: { state: "approval-responded", approval: { id: "storybook-approval", approved: true } },
}
export const Rejected: Story = {
  args: { state: "output-denied", approval: { id: "storybook-approval", approved: false } },
}
