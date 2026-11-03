import type { Meta, StoryObj } from "@storybook/nextjs"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { useSkillPanelToolbar } from "./skill-panel-toolbar"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSkillsStore } from "@/stores/skills"
import { useSettingsStore } from "@/stores/settings"

/**
 * The toolbar is a hook that feeds the page header's typed actions, so the
 * story draws it where it lives. Reads the skills + settings stores and
 * several skill hooks; file-system actions resolve through the (web) file
 * bridge on click.
 */
function SkillPanelToolbarPreview() {
  const toolbar = useSkillPanelToolbar()
  return (
    <FeaturePageHeader
      title="Skills"
      actions={toolbar.importMenu}
      secondaryActions={toolbar.secondaryActions}
      overflowActions={toolbar.overflowActions}
      primaryAction={toolbar.primaryAction}
    />
  )
}

const meta = {
  title: "Skills/SkillPanelToolbar",
  component: SkillPanelToolbarPreview,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSkillsStore)
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof SkillPanelToolbarPreview>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
