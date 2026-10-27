import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { HomeTab } from "./home-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { usePetStore } from "@/stores/pet/pet-store"
import { makePetProfile, makePetView, makePetNeeds } from "@/lib/storybook/fixtures/pet-core"

// The `/pet` console's Home: the pet on the console's one accent surface with
// its needs, then "Most needed now" with the care that answers it, every care
// action, the backpack and coins, a quick-talk field and the stats.
const meta = {
  title: "Pet/Console/HomeTab",
  component: HomeTab,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(usePetStore)
  },
  args: {
    profile: makePetProfile(),
    view: makePetView(),
    onCare: fn(),
    onTalk: fn(),
    onOpenShop: fn(),
    onOpenChat: fn(),
  },
  decorators: [
    // Home lays out against the console's scrolling pane, which is the
    // `pet-pane` container its two-column breakpoint measures.
    (Story) => (
      <div className="@container/pet-pane px-6 py-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HomeTab>

export default meta
type Story = StoryObj<typeof meta>

export const Content: Story = {
  args: { view: makePetView({ needs: makePetNeeds({ energy: 88, mood: 92, bond: 80 }) }) },
}

export const NeedsAttention: Story = {
  args: { view: makePetView({ needs: makePetNeeds({ energy: 42, mood: 70, bond: 66 }) }) },
}

export const Neglected: Story = {
  args: { view: makePetView({ needs: makePetNeeds({ energy: 8, mood: 18, bond: 30 }) }) },
}

export const PairedPhone: Story = {
  args: { talkMode: "direct", showPluginActions: false },
}
