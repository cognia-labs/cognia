import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"
import { FilesRemoteNotice } from "./files-remote-notice"

const meta = {
  title: "Files/RemoteNotice",
  component: FilesRemoteNotice,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Disconnected paired-library notice. Retry is a resolving callback spy; no host or network request is contacted. Unknown error codes use the real localized fallback. A healthy read renders no notice.",
      },
    },
  },
  args: { error: "files_remote_unreachable", refresh: fn(async () => undefined) },
  argTypes: { error: { control: "text" }, touch: { control: "boolean" } },
  decorators: [
    (Story) => (
      <div className="w-[40rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FilesRemoteNotice>
export default meta
type Story = StoryObj<typeof meta>
export const Disconnected: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button"))
    await expect(args.refresh).toHaveBeenCalledTimes(1)
  },
}
export const UnknownError: Story = { args: { error: "synthetic-unknown-code" } }
export const Touch: Story = { args: { touch: true } }
export const HealthyHidden: Story = {
  args: { error: undefined },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("alert")).not.toBeInTheDocument()
  },
}
