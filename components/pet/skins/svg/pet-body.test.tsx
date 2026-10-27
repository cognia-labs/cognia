import { render } from "@testing-library/react"
import { PetBody, bodyDims, headTop } from "./pet-body"
import { ALL_PET_SPECIES, getSpeciesTraits } from "@/lib/pet/skins/species-traits"
import type { PetBones, PetBodyType, PetHat } from "@/types/pet"

function makeBones(overrides: Partial<PetBones> = {}): PetBones {
  return {
    species: "cat",
    rarity: "common",
    stars: 1,
    eyes: "dot",
    hat: "none",
    shiny: false,
    bodyType: "round",
    palette: { primary: "#aabbcc", secondary: "#ddeeff", accent: "#112233" },
    stats: { debugging: 1, patience: 1, chaos: 1, wisdom: 1, snark: 1 },
    ...overrides,
  }
}

describe("PetBody", () => {
  it("renders a body with species + body-type markers for every species", () => {
    for (const species of ALL_PET_SPECIES) {
      const { container, unmount } = render(
        <svg>
          <PetBody bones={makeBones({ species })} />
        </svg>
      )
      expect(container.querySelector(`[data-species="${species}"]`)).not.toBeNull()
      unmount()
    }
  })

  it("renders every hat variant", () => {
    const hats: PetHat[] = [
      "none",
      "crown",
      "tophat",
      "propeller",
      "halo",
      "wizard",
      "beanie",
      "tinyduck",
    ]
    for (const hat of hats) {
      const { container, unmount } = render(
        <svg>
          <PetBody bones={makeBones({ hat })} />
        </svg>
      )
      if (hat === "none") {
        expect(container.querySelector('[data-pet-part="hat"]')).toBeNull()
      } else {
        expect(container.querySelector(`[data-hat="${hat}"]`)).not.toBeNull()
      }
      unmount()
    }
  })

  it("renders all three body types", () => {
    const types: PetBodyType[] = ["round", "tall", "wide"]
    for (const bodyType of types) {
      const { container, unmount } = render(
        <svg>
          <PetBody bones={makeBones({ bodyType })} />
        </svg>
      )
      expect(container.querySelector(`[data-body-type="${bodyType}"]`)).not.toBeNull()
      unmount()
    }
  })

  it("omits cheeks for a non-cheeky species (owl)", () => {
    const { container } = render(
      <svg>
        <PetBody bones={makeBones({ species: "owl" })} />
      </svg>
    )
    expect(container.querySelector('[data-pet-part="cheeks"]')).toBeNull()
  })

  function renderBody(over: Partial<PetBones> = {}) {
    return render(
      <svg>
        <PetBody bones={makeBones(over)} />
      </svg>
    )
  }

  it("draws each species' own parts: silhouette, feet, arms and signature feature", () => {
    for (const species of ALL_PET_SPECIES) {
      const traits = getSpeciesTraits(species)
      const { container, unmount } = renderBody({ species })
      const body = container.querySelector('[data-pet-part="body"]')
      expect(body).toHaveAttribute("data-silhouette", traits.silhouette)
      const feet = container.querySelector('[data-pet-part="feet"]')
      if (traits.feet === "none") expect(feet).toBeNull()
      else expect(feet).toHaveAttribute("data-feet", traits.feet)
      const arms = container.querySelector('[data-pet-part="arms"]')
      if (traits.arms === "none") expect(arms).toBeNull()
      else expect(arms).toHaveAttribute("data-arms", traits.arms)
      if (traits.feature !== "none") {
        expect(container.querySelector('[data-pet-part="feature"]')).not.toBeNull()
      }
      unmount()
    }
  })

  it("names the species that looked alike before by their signature feature", () => {
    const expected: Record<string, string> = {
      mushroom: "cap",
      cactus: "spines",
      turtle: "shell",
      snail: "spiral-shell",
      blob: "puddle",
    }
    for (const [species, feature] of Object.entries(expected)) {
      const { container, unmount } = renderBody({ species: species as PetBones["species"] })
      expect(container.querySelector(`[data-feature="${feature}"]`)).not.toBeNull()
      unmount()
    }
    const ghost = renderBody({ species: "ghost" })
    expect(ghost.container.querySelector('[data-silhouette="ghost"]')).not.toBeNull()
    ghost.unmount()
    const octopus = renderBody({ species: "octopus" })
    expect(octopus.container.querySelector('[data-silhouette="tentacles"]')).not.toBeNull()
  })

  it("shades the body with gradients unique to each rendered pet", () => {
    const { container } = render(
      <svg>
        <PetBody bones={makeBones()} />
        <PetBody bones={makeBones({ species: "rabbit" })} />
      </svg>
    )
    const ids = Array.from(container.querySelectorAll("radialGradient, linearGradient")).map(
      (g) => g.id
    )
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    // Every gradient reference resolves to a gradient in the same document.
    const refs = Array.from(container.querySelectorAll("[fill]"))
      .map((el) => el.getAttribute("fill") ?? "")
      .filter((fill) => fill.startsWith("url(#"))
      .map((fill) => fill.slice(5, -1))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) expect(ids).toContain(ref)
  })

  it("seats the hat on the head for every body type instead of a fixed height", () => {
    const crownBaseY = (bodyType: PetBodyType) => {
      const { container, unmount } = renderBody({ bodyType, hat: "crown", species: "fox" })
      const d = container.querySelector('[data-hat="crown"]')?.getAttribute("d") ?? ""
      unmount()
      return Number(d.split(" ")[2])
    }
    for (const bodyType of ["round", "tall", "wide"] as const) {
      const dims = bodyDims(makeBones({ bodyType, species: "fox" }), getSpeciesTraits("fox"))
      expect(crownBaseY(bodyType)).toBeCloseTo(headTop(dims) + 2)
    }
    // A wide body's head is lower, so its hat is too.
    expect(crownBaseY("wide")).toBeGreaterThan(crownBaseY("tall"))
  })

  it("sets a hat on top of a mushroom's cap", () => {
    const dims = bodyDims(makeBones({ species: "mushroom" }), getSpeciesTraits("mushroom"))
    const { container } = renderBody({ species: "mushroom", hat: "crown" })
    const d = container.querySelector('[data-hat="crown"]')?.getAttribute("d") ?? ""
    expect(Number(d.split(" ")[2])).toBeLessThan(headTop(dims))
  })

  it("keeps the mushroom cap above the eyes", () => {
    const { container } = renderBody({ species: "mushroom", bodyType: "wide" })
    const d = container.querySelector('[data-feature="cap"] path')?.getAttribute("d") ?? ""
    // The rim is the path's start point; the eyes start at y≈43.5.
    expect(Number(d.split(" ")[2])).toBeLessThanOrEqual(43)
  })
})
