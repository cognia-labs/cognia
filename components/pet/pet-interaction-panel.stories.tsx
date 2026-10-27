import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PetInteractionPanel } from "./pet-interaction-panel"
import { resetStore } from "@/lib/storybook/seed-stores"
import { usePetStore } from "@/stores/pet/pet-store"
import { makePetProfile, makePetView, makePetNeeds } from "@/lib/storybook/fixtures/pet-core"

// The desktop popup's pet panel, a mini version of the console's Home: stat
// card, level and needs, "Most needed now", the six care actions and a quick
// talk field. Reads `lastGrewStats` and the action cooldowns from the pet
// store, so reset it between stories.
const meta = {
  title: "Pet/InteractionPanel",
  component: PetInteractionPanel,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(usePetStore)
  },
  args: {
    profile: makePetProfile(),
    view: makePetView(),
    onCare: fn(),
    onTalk: fn(),
  },
  decorators: [
    (Story) => (
      <div className="rounded-xl border bg-popover p-3 shadow-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetInteractionPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Healthy: Story = {}

export const LowNeeds: Story = {
  args: {
    view: makePetView({ needs: makePetNeeds({ energy: 14, mood: 28, bond: 40 }) }),
  },
}

export const FreshlyHatched: Story = {
  args: {
    profile: makePetProfile({ xp: 5, level: 1, stage: "baby" }),
  },
}
