import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, within } from "storybook/test"
import { WakeupCueChip } from "./wakeup-cue-chip"

const meta = {
  title: "Issues/WakeupCueChip",
  component: WakeupCueChip,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Read-only summary of waiting and paused wakeup rules. Paused rules take visual precedence; the accessible label and tooltip also name waiting rules, the pause reason, and held inputs. Counts are synthetic; no scheduler or wakeup is registered.",
      },
    },
  },
  args: { cue: { active: 3, paused: 0, held: 0 } },
  argTypes: { cue: { control: "object" } },
} satisfies Meta<typeof WakeupCueChip>
export default meta
type Story = StoryObj<typeof meta>
export const Waiting: Story = {
  play: async ({ canvasElement }) => {
    const chip = within(canvasElement).getByRole("img")
    await expect(chip).toHaveAccessibleName()
    await expect(chip).toHaveTextContent("3")
  },
}
export const PausedWithHeldInputs: Story = {
  args: { cue: { active: 1, paused: 2, pauseReason: "loop", held: 3 } },
  play: async ({ canvasElement }) => {
    const chip = within(canvasElement).getByRole("img")
    await expect(chip).toHaveAttribute("data-state", "paused")
    await expect(chip).toHaveTextContent("2")
    await expect(chip.getAttribute("aria-label")).toContain("3")
  },
}
export const PausedUnknownReason: Story = { args: { cue: { active: 0, paused: 2, held: 0 } } }
export const Hidden: Story = {
  args: { cue: { active: 0, paused: 0, held: 0 } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("img")).not.toBeInTheDocument()
  },
}
