import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"
import { computePermissionDiff } from "@/lib/creator/permission-diff"
import { PermissionDiffPanel } from "./permission-diff-panel"

const diff = computePermissionDiff({ current: ["storage"], proposed: ["storage", "network"] })
const meta = {
  title: "Creator/PermissionDiff",
  component: PermissionDiffPanel,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Permission gate snapshots derived by the real diff function. Approve only records the exact additions in a spy; it grants no capability and writes no files. Changed proposals invalidate prior approval, as required by ADR-0117.",
      },
    },
  },
  args: { diff, approvedAdditions: [], onApprove: fn() },
  argTypes: {
    disabled: { control: "boolean" },
    diff: { control: "object" },
    approvedAdditions: {
      control: "object",
      description: "Exact additions approved for this proposal.",
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[40rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PermissionDiffPanel>
export default meta
type Story = StoryObj<typeof meta>
export const Pending: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button"))
    await expect(args.onApprove).toHaveBeenCalledWith(diff.added)
  },
}
export const Approved: Story = { args: { approvedAdditions: diff.added } }
export const StaleApproval: Story = { args: { approvedAdditions: ["clipboard"] } }
export const NoChanges: Story = {
  args: { diff: computePermissionDiff({ current: ["storage"], proposed: ["storage"] }) },
}
export const Disabled: Story = { args: { disabled: true } }
