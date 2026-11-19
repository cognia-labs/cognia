import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { Message, MessageContent } from "./message"

const meta = {
  title: "AI Elements/Message",
  component: Message,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real message framing for user and assistant roles. This fixture uses plain translated text, without a chat controller, markdown plugins, model calls or conversation persistence.",
      },
    },
  },
  args: { from: "assistant" },
  argTypes: { from: { control: "select", options: ["user", "assistant", "system"] } },
  render: function Example(args) {
    const t = useTranslations("common")
    return (
      <div className="w-96 max-w-full">
        <Message {...args}>
          <MessageContent>{t("confirm")}</MessageContent>
        </Message>
      </div>
    )
  },
} satisfies Meta<typeof Message>
export default meta
type Story = StoryObj<typeof meta>
export const Assistant: Story = {}
export const User: Story = { args: { from: "user" } }
