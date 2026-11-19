import type { Meta, StoryObj } from "@storybook/nextjs"
import { CREATOR_STEP_IDS } from "@/lib/creator/steps"
import { CreatorStepRail } from "./creator-step-rail"

const meta = {
  title: "Creator/StepRail",
  component: CreatorStepRail,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Nine-step read-only progress rail derived from the real canAdvance gates (ADR-0117). Completed steps and approvals are fixtures; nothing executes or grants authority. The awaiting-permission state precedes the first write-capable step.",
      },
    },
  },
  args: { state: { completed: [], approvals: [] } },
  argTypes: {
    state: { control: "object" },
    activeStep: { control: "select", options: [null, ...CREATOR_STEP_IDS] },
    failed: { control: "object" },
  },
  decorators: [
    (Story) => (
      <div className="w-96 max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CreatorStepRail>
export default meta
type Story = StoryObj<typeof meta>
export const New: Story = {}
export const AwaitingPermission: Story = {
  args: {
    state: {
      completed: ["collect-requirements", "survey-existing", "plan-scaffold"],
      approvals: [],
    },
  },
}
export const Verifying: Story = {
  args: {
    state: { completed: CREATOR_STEP_IDS.slice(0, 5), approvals: ["permission-widening"] },
    activeStep: "verify",
  },
}
export const FailedReview: Story = {
  args: {
    state: { completed: CREATOR_STEP_IDS.slice(0, 7), approvals: ["permission-widening"] },
    failed: ["review"],
  },
}
export const Complete: Story = {
  args: { state: { completed: CREATOR_STEP_IDS, approvals: ["permission-widening", "install"] } },
}
