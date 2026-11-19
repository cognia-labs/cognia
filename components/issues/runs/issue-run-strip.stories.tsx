import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, within } from "storybook/test"
import type { IssueRun, IssueRunStatus } from "@/types/issues"
import { IssueRunStrip } from "./issue-run-strip"

function runs(statuses: IssueRunStatus[]): IssueRun[] {
  return statuses
    .map((status, index): IssueRun => ({
      id: `run-${index}`,
      issueId: "fixture-issue",
      projectId: "fixture-project",
      adapterId: "agent-task",
      kind: "agent-task",
      targetId: "fixture-task",
      status,
      by: { kind: "human" },
      startedAt: 1_700_000_000_000 + index * 60_000,
      updatedAt: 1_700_000_000_000 + index * 60_000,
      artifacts: [],
    }))
    .reverse()
}
const meta = {
  title: "Issues/IssueRunStrip",
  component: IssueRunStrip,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Informational run history with accessible engine, outcome and timestamp labels. Input is newest first; marks render oldest first. Timestamps are fixed synthetic UTC instants (display formatting follows the browser locale). One or zero runs intentionally hide the strip. No engine is started.",
      },
    },
  },
  args: { runs: runs(["failed", "failed", "succeeded"]) },
  argTypes: { runs: { control: "object", description: "Newest-first IssueRun records." } },
} satisfies Meta<typeof IssueRunStrip>
export default meta
type Story = StoryObj<typeof meta>
export const RetryThenSuccess: Story = {
  play: async ({ canvasElement }) => {
    const marks = within(canvasElement).getAllByRole("listitem")
    await expect(marks).toHaveLength(3)
    await expect(marks[0]).toHaveAttribute("data-testid", "issue-run-strip-failed")
    await expect(marks[2]).toHaveAttribute("data-testid", "issue-run-strip-succeeded")
    for (const mark of marks) await expect(mark).toHaveAccessibleName()
  },
}
export const AllStatuses: Story = {
  args: { runs: runs(["queued", "running", "succeeded", "failed", "cancelled"]) },
}
export const SingleHidden: Story = {
  args: { runs: runs(["succeeded"]) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("list")).not.toBeInTheDocument()
  },
}
export const EmptyHidden: Story = { ...SingleHidden, args: { runs: [] } }
