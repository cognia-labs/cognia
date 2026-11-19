import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, within } from "storybook/test"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useCreatorStore } from "@/stores/creator/creator-store"
import { AuthoringRootCard } from "./authoring-root-card"

const meta = {
  title: "Creator/AuthoringRoot",
  component: AuthoringRootCard,
  tags: ["quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real browser host-unavailable state: directory picking is disabled with an explanation. The optional grant is a fixed in-memory fixture; revoke changes only preview state. No native API is fabricated. Reset before each canvas; avoid mounting both store-mutating examples together.",
      },
    },
  },
  beforeEach: () => {
    resetStore(useCreatorStore)
  },
  decorators: [
    (Story) => (
      <div className="w-[40rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AuthoringRootCard>
export default meta
type Story = StoryObj<typeof meta>
export const HostUnavailable: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button")).toBeDisabled()
  },
}
export const ExistingGrant: Story = {
  beforeEach: () => {
    resetStore(useCreatorStore)
    seedStore(useCreatorStore, {
      authoringRoot: {
        path: "/storybook/authoring",
        label: "authoring",
        origin: "selected",
        grantedAt: 1_700_000_000_000,
      },
    })
  },
}
