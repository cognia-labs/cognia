import type { Meta, StoryObj } from "@storybook/nextjs"

import { svgSkin } from "./svg-skin"
import { makePetBones } from "@/lib/storybook/fixtures/pet-core"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import { paletteFromHue } from "@/lib/pet/bones/generate"
import type { PetEyes, PetHat } from "@/types/pet"

// Every species of the vector mascot side by side, still, across the three
// body types and a spread of rolled palettes: the one place to judge the
// family as a whole (silhouettes, ears, faces, contrast on light and dark).
const BODY_TYPES = ["round", "tall", "wide"] as const
const EYES: PetEyes[] = ["dot", "wide", "dot"]

function Gallery({ hats = false }: { hats?: boolean }) {
  const hatCycle: PetHat[] = ["crown", "tophat", "propeller", "halo", "wizard", "beanie"]
  return (
    <div
      data-testid="pet-svg-gallery"
      style={{ display: "grid", gridTemplateColumns: "repeat(6, 132px)", gap: "28px 16px" }}
    >
      {ALL_PET_SPECIES.map((species, i) => (
        <div
          key={species}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
        >
          {svgSkin.render({
            stage: "adult",
            state: "idle",
            oneShot: null,
            size: 120,
            reducedMotion: true,
            bones: makePetBones({
              species,
              hat: hats ? hatCycle[i % hatCycle.length] : "none",
              shiny: false,
              rarity: "common",
              eyes: EYES[i % EYES.length],
              bodyType: BODY_TYPES[i % BODY_TYPES.length],
              palette: paletteFromHue((i * 47) % 360),
            }),
          })}
          <span className="text-xs text-muted-foreground">{species}</span>
        </div>
      ))}
    </div>
  )
}

const meta = {
  title: "Pet/Skins/SvgSkinGallery",
  component: Gallery,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Gallery>

export default meta
type Story = StoryObj<typeof meta>

export const AllSpecies: Story = {}

export const WithHats: Story = { args: { hats: true } }
