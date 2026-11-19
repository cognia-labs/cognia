import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { expect, userEvent, within } from "storybook/test"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning"

const meta = {
  title: "AI Elements/Reasoning",
  component: Reasoning,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Reasoning disclosure with fixed duration and explicit translated trigger content. Streaming is a prop snapshot, not a model stream. Completed content remains open only when closeOnFinish is false; no provider or store is mounted.",
      },
    },
  },
  args: { defaultOpen: false, duration: 3, closeOnFinish: false },
  argTypes: {
    isStreaming: { control: "boolean" },
    defaultOpen: { control: "boolean" },
    closeOnFinish: { control: "boolean" },
  },
  render: function Example(args) {
    const t = useTranslations("common")
    return (
      <div className="w-96 max-w-full">
        <Reasoning {...args}>
          <ReasoningTrigger>{t("more")}</ReasoningTrigger>
          <ReasoningContent>{t("confirm")}</ReasoningContent>
        </Reasoning>
      </div>
    )
  },
} satisfies Meta<typeof Reasoning>
export default meta
type Story = StoryObj<typeof meta>
export const Collapsed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const button = canvas.getByRole("button")
    await expect(button).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(button)
    await expect(button).toHaveAttribute("aria-expanded", "true")
  },
}
export const Completed: Story = { args: { defaultOpen: true } }
export const Streaming: Story = { args: { isStreaming: true, defaultOpen: true } }
