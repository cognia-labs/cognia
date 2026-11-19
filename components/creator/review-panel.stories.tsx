import type { Meta, StoryObj } from "@storybook/nextjs"
import { ReviewPanel } from "./review-panel"

const meta = {
  title: "Creator/Review",
  component: ReviewPanel,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Read-only independent review verdicts with synthetic findings and explicit reviewer authority. No reviewer/model runs and no proposal is executed. Pending, approved and blocked states stay visibly distinct.",
      },
    },
  },
  args: { verdict: null },
  argTypes: {
    verdict: {
      control: "object",
      description: "Synthetic verdict, or null before the review finishes.",
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[40rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ReviewPanel>
export default meta
type Story = StoryObj<typeof meta>
export const Pending: Story = {}
export const Approved: Story = {
  args: { verdict: { approved: true, reviewerAuthority: "plan", findings: [] } },
}
export const Blocked: Story = {
  args: {
    verdict: {
      approved: false,
      reviewerAuthority: "plan",
      findings: [
        {
          id: "finding-1",
          severity: "blocker",
          summary: "Synthetic review: a required permission was not declared.",
          path: "src/example.ts",
        },
      ],
    },
  },
}
export const Warning: Story = {
  args: {
    verdict: {
      approved: true,
      reviewerAuthority: "plan",
      findings: [
        {
          id: "finding-2",
          severity: "warning",
          summary: "Synthetic review: verify the disconnected-host state.",
          path: "src/example.ts",
        },
      ],
    },
  },
}
