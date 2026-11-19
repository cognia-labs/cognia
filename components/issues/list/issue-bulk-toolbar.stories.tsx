import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"
import { statusCategoryOf } from "@/types/issues"
import {
  FULL_ISSUE_CAPABILITIES,
  READ_ONLY_ISSUE_CAPABILITIES,
  type UnifiedIssueItem,
} from "@/types/issues/unified"
import { IssueBulkToolbar } from "./issue-bulk-toolbar"

function item(sourceId: string, kind: "local" | "github" = "local"): UnifiedIssueItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    identifier: `DEMO-${sourceId}`,
    title: "Synthetic issue",
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 1,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
  }
}
const meta = {
  title: "Issues/IssueBulkToolbar",
  component: IssueBulkToolbar,
  tags: ["quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Selection actions with real capability and running-run eligibility. Local and read-only mirrored rows deliberately share one selection: menu counts describe only applicable rows. All mutations, select-all, clearing, and delete confirmation are spies. Portal scenarios stay on individual canvases; no issue repository is written.",
      },
    },
  },
  args: {
    items: [item("1"), item("2", "github")],
    runningIds: new Set<string>(),
    labels: [
      {
        id: "bug",
        scope: "issue",
        name: "Synthetic bug",
        sortOrder: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    projects: [],
    assigneeOptions: [],
    onAction: fn(),
    onRequestDelete: fn(),
    onClear: fn(),
  },
  argTypes: {
    onAction: { description: "Records the typed bulk action without persisting it." },
    onRequestDelete: { description: "Requests confirmation; never directly deletes rows." },
  },
  decorators: [
    (Story) => (
      <div className="w-[48rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IssueBulkToolbar>
export default meta
type Story = StoryObj<typeof meta>
export const MixedSelection: Story = {
  play: async ({ canvasElement, args }) => {
    const toolbar = within(canvasElement).getByRole("toolbar")
    const status = within(toolbar).getAllByRole("button")[0]!
    await userEvent.click(status)
    const body = within(canvasElement.ownerDocument.body)
    const option = body
      .getAllByRole("menuitem")
      .find((entry) => entry.getAttribute("data-testid") === "issue-bulk-status-done")!
    await expect(option).toHaveTextContent("1")
    await userEvent.click(option)
    await expect(args.onAction).toHaveBeenCalledWith({ kind: "status", to: "done" })
  },
}
export const AllReadOnly: Story = {
  args: { items: [item("2", "github")] },
  play: async ({ canvasElement }) => {
    const toolbar = within(canvasElement).getByRole("toolbar")
    await userEvent.click(within(toolbar).getAllByRole("button")[0]!)
    for (const option of within(canvasElement.ownerDocument.body).getAllByRole("menuitem"))
      await expect(option).toHaveAttribute("aria-disabled", "true")
    await userEvent.keyboard("{Escape}")
  },
}
export const RunningLocal: Story = {
  args: {
    items: [
      { ...item("1"), status: "in_progress", statusCategory: statusCategoryOf("in_progress") },
    ],
    runningIds: new Set(["local:1"]),
  },
  parameters: {
    docs: {
      description: {
        story:
          "The active-run set uses unified IDs, matching the toolbar gate. Moving the running issue to Done is unavailable; other metadata actions remain distinct.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(within(canvasElement).getByRole("toolbar")).getAllByRole("button")[0]!
    )
    const done = within(canvasElement.ownerDocument.body)
      .getAllByRole("menuitem")
      .find((entry) => entry.getAttribute("data-testid") === "issue-bulk-status-done")!
    await expect(done).toHaveAttribute("aria-disabled", "true")
    await userEvent.keyboard("{Escape}")
  },
}
export const RequestDelete: Story = {
  args: { items: [item("1")] },
  play: async ({ canvasElement, args }) => {
    const toolbar = within(canvasElement).getByRole("toolbar")
    const button = within(toolbar)
      .getAllByRole("button")
      .find((entry) => entry.getAttribute("data-testid") === "issue-bulk-delete")!
    await userEvent.click(button)
    await expect(args.onRequestDelete).toHaveBeenCalledOnce()
    await expect(args.onAction).not.toHaveBeenCalled()
  },
}
export const SelectAll: Story = {
  args: { visibleCount: 12, onToggleAll: fn() },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /12/ }))
    await expect(args.onToggleAll).toHaveBeenCalledOnce()
  },
}
export const EmptyHidden: Story = {
  args: { items: [] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("toolbar")).not.toBeInTheDocument()
  },
}
