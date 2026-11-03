import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs"
import {
  ArchiveIcon,
  CopyIcon,
  DownloadIcon,
  FilePlus2Icon,
  FilterIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  UploadIcon,
  WorkflowIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  FeaturePageHeader,
  type FeatureHeaderStatusTone,
  type FeaturePageHeaderProps,
} from "./feature-page-header"

/**
 * One story per header rule (see the doc comment in `feature-page-header.tsx`):
 * the identity row, the view bar (tabs, search, controls), a split primary,
 * secondary actions folding into "⋯", a sub-page's way back, and the status
 * tones.
 */
const meta = {
  title: "FeatureShell/FeaturePageHeader",
  component: FeaturePageHeader,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof FeaturePageHeader>

export default meta
type Story = StoryObj<typeof meta>

/** Row 1 alone: icon tile, title, one chip, description, context, and actions. */
export const IdentityRow: Story = {
  args: {
    icon: <WorkflowIcon />,
    title: "Workflows",
    description: "Build, organize, and run repeatable automations",
    context: "Root folder",
    status: { label: "Ready", tone: "success" },
    summary: "12 workflows",
    refresh: { label: "Refresh", onSelect: () => {} },
    primaryAction: { id: "create", label: "New workflow", icon: PlusIcon },
  },
}

const VIEW_TABS = [
  { value: "all", label: "All", count: 12 },
  { value: "active", label: "Active", count: 3 },
  { value: "drafts", label: "Drafts", count: 9 },
] as const

/** Row 2: tabs on the left, then search, then filter and view controls pushed right. */
function ViewBarHeader(props: Partial<FeaturePageHeaderProps>) {
  const [tab, setTab] = useState<string>("all")
  const [query, setQuery] = useState("")
  const [layout, setLayout] = useState("grid")
  return (
    <FeaturePageHeader
      icon={<WorkflowIcon />}
      title="Workflows"
      description="Build, organize, and run repeatable automations"
      summary="12 workflows"
      primaryAction={{ id: "create", label: "New workflow", icon: PlusIcon }}
      tabs={{
        items: VIEW_TABS,
        value: tab,
        onValueChange: setTab,
        ariaLabel: "Workflow views",
      }}
      search={{ value: query, onChange: setQuery, placeholder: "Search workflows" }}
      controls={
        <>
          <Button variant="ghost" size="sm">
            <FilterIcon />
            Filters
          </Button>
          <ToggleGroup
            type="single"
            size="sm"
            value={layout}
            onValueChange={(value) => {
              if (value) setLayout(value)
            }}
            aria-label="Layout"
          >
            <ToggleGroupItem value="grid" aria-label="Grid">
              <LayoutGridIcon className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List">
              <ListIcon className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </>
      }
      {...props}
    />
  )
}

export const ViewBar: Story = {
  args: { title: "Workflows" },
  render: () => <ViewBarHeader />,
}

/** Route tabs: each tab is a link, the current route is the value. */
export const RouteTabs: Story = {
  args: {
    icon: <WorkflowIcon />,
    title: "Issues",
    description: "Track work across projects and cycles",
    tabs: {
      items: [
        { value: "issues", label: "Issues", href: "/issues" },
        { value: "projects", label: "Projects", href: "/issues/projects" },
        { value: "cycles", label: "Cycles", href: "/issues/cycles" },
      ],
      value: "issues",
      ariaLabel: "Issue views",
    },
  },
}

/** "Create ▾": the primary button with a menu of related creations, drawn last. */
export const SplitPrimary: Story = {
  args: {
    icon: <WorkflowIcon />,
    title: "Mini apps",
    description: "Generate, edit and share small interactive apps",
    primaryAction: {
      id: "generate",
      label: "New app",
      icon: PlusIcon,
      menuLabel: "More ways to create",
      menu: [
        { id: "blank", label: "Blank app", icon: FilePlus2Icon },
        { id: "import", label: "Import from file", icon: UploadIcon },
      ],
    },
  },
}

/**
 * Pass every secondary action in priority order: the first two show as buttons
 * and the rest fold into "⋯" with the overflow-only items.
 */
export const FoldedSecondaryActions: Story = {
  args: {
    icon: <WorkflowIcon />,
    title: "Plugins",
    description: "Manage installed extensions and runtime capabilities",
    refresh: { label: "Check for updates", onSelect: () => {}, busy: true },
    primaryAction: { id: "install", label: "Install plugin", icon: PlusIcon },
    secondaryActions: [
      { id: "export", label: "Export", icon: DownloadIcon },
      { id: "settings", label: "Settings", icon: SettingsIcon },
      { id: "duplicate", label: "Duplicate", icon: CopyIcon },
      { id: "archive", label: "Archive", icon: ArchiveIcon, disabled: true },
    ],
    overflowActions: [
      { id: "remove-all", label: "Remove all", icon: Trash2Icon, destructive: true },
    ],
  },
}

/** A sub-page: the way back stands where the icon tile would be. */
export const BackSubPage: Story = {
  args: {
    back: { label: "Back to plugins", onSelect: () => {} },
    title: "Plugin details",
    description: "Permissions, settings and logs for one plugin",
    status: { label: "Enabled", tone: "success" },
    secondaryActions: [{ id: "settings", label: "Settings", icon: SettingsIcon }],
  },
}

const TONES: readonly { tone: FeatureHeaderStatusTone; label: string }[] = [
  { tone: "neutral", label: "Idle" },
  { tone: "success", label: "Healthy" },
  { tone: "warning", label: "Degraded" },
  { tone: "danger", label: "Error" },
  { tone: "active", label: "Running" },
]

/** The one status chip in each tone: running → active, ok → success, and so on. */
export const StatusTones: Story = {
  args: { title: "Status" },
  render: () => (
    <div className="flex flex-col gap-2">
      {TONES.map(({ tone, label }) => (
        <FeaturePageHeader
          key={tone}
          icon={<WorkflowIcon />}
          title={`Status: ${tone}`}
          description="Map the page's state to one tone"
          status={{ label, tone, title: `Tone "${tone}"` }}
        />
      ))}
    </div>
  ),
}

/** Column-height band, only for a header that titles a column inside another shell. */
export const Compact: Story = {
  args: {
    variant: "compact",
    icon: <WorkflowIcon />,
    title: "Workflow editor",
    status: { label: "Saved", tone: "neutral" },
    primaryAction: { id: "run", label: "Run", icon: PlusIcon },
  },
}

/**
 * The raised variant used by scrolling document pages that have no band to
 * sit in. `SettingsPageHeader` is this variant with `headingLevel={2}` — the
 * two used to be separate components with the same visual DNA (ADR-0148).
 */
export const Card: Story = {
  args: {
    variant: "card",
    icon: <WorkflowIcon />,
    title: "Evaluation",
    description: "Configure judge defaults",
    secondaryActions: [{ id: "reset", label: "Reset" }],
  },
}

export const LongLocalizedContent: Story = {
  args: {
    icon: <WorkflowIcon />,
    title: "自动化工作流与重复任务管理",
    description: "创建、组织并运行可重复使用的自动化流程，同时保留完整的运行上下文",
    context: "企业级自动化工作区",
    status: { label: "运行中", tone: "active" },
    primaryAction: { id: "create", label: "创建新工作流", icon: PlusIcon },
    overflowLabel: "更多工作流操作",
    secondaryActions: [
      { id: "export", label: "导出全部工作流", icon: DownloadIcon },
      { id: "settings", label: "工作流设置", icon: SettingsIcon },
      { id: "archive", label: "归档", icon: ArchiveIcon },
    ],
  },
}

export const NarrowContainer: Story = {
  args: { title: "Workflows" },
  render: () => <ViewBarHeader />,
  decorators: [
    (Story) => (
      <div className="w-[360px] resize-x overflow-auto border">
        <Story />
      </div>
    ),
  ],
}

export const ReducedMotion: Story = {
  args: IdentityRow.args,
  parameters: {
    chromatic: { prefersReducedMotion: "reduce" },
  },
}
