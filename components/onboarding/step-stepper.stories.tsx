import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"
import { resolveStepSequence } from "@/lib/onboarding/steps"
import { StepStepper } from "./step-stepper"

const meta = {
  title: "Onboarding/StepStepper",
  component: StepStepper,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Progress rail uses the canonical shell/mode step resolver. Only completed steps can call the navigation spy; future steps stay gated. This renders the rail only: no scan, credential login, provider setup or native onboarding runs.",
      },
    },
  },
  args: {
    sequence: resolveStepSequence({ shell: "tauri", mode: "custom", hasModelAccess: false }),
    current: "provider",
    onStepChange: fn(),
  },
  argTypes: {
    busy: { control: "boolean" },
    current: { control: "text" },
    sequence: { control: "object" },
  },
  decorators: [
    (Story) => (
      <div className="w-[48rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StepStepper>
export default meta
type Story = StoryObj<typeof meta>
export const DesktopCustom: Story = {
  play: async ({ canvasElement, args }) => {
    const previous = within(canvasElement)
      .getAllByRole("button")
      .find((button) => !button.hasAttribute("disabled"))!
    await userEvent.click(previous)
    await expect(args.onStepChange).toHaveBeenCalledTimes(1)
  },
}
export const BrowserCustom: Story = {
  args: { sequence: resolveStepSequence({ shell: "web", mode: "custom", hasModelAccess: false }) },
}
export const Busy: Story = { args: { busy: true } }
export const ReadOnly: Story = { args: { onStepChange: undefined } }
