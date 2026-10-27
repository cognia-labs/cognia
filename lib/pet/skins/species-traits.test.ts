import { getSpeciesTraits, ALL_PET_SPECIES } from "./species-traits"

describe("species traits", () => {
  it("defines traits for all 18 species", () => {
    expect(ALL_PET_SPECIES).toHaveLength(18)
  })

  it("returns a complete, well-formed trait set for every species", () => {
    for (const species of ALL_PET_SPECIES) {
      const t = getSpeciesTraits(species)
      expect(t.roundness).toBeGreaterThanOrEqual(0)
      expect(t.roundness).toBeLessThanOrEqual(1)
      expect(typeof t.cheeks).toBe("boolean")
      expect(t.ears).toBeDefined()
      expect(t.tail).toBeDefined()
      expect(t.face).toBeDefined()
      expect(["mochi", "box", "ghost", "tentacles"]).toContain(t.silhouette)
      expect(["paws", "webbed", "none"]).toContain(t.feet)
      expect(["nubs", "wings", "none"]).toContain(t.arms)
      expect(t.feature).toBeDefined()
    }
  })

  it("gives every species a distinct combination of parts", () => {
    const keys = ALL_PET_SPECIES.map((species) => {
      const t = getSpeciesTraits(species)
      return [t.silhouette, t.ears, t.tail, t.face, t.feet, t.arms, t.feature].join("/")
    })
    expect(new Set(keys).size).toBe(ALL_PET_SPECIES.length)
  })

  it("stands the birds on webbed feet and gives the hem-bodied species none", () => {
    expect(getSpeciesTraits("duck").feet).toBe("webbed")
    expect(getSpeciesTraits("penguin").feet).toBe("webbed")
    expect(getSpeciesTraits("ghost").feet).toBe("none")
    expect(getSpeciesTraits("octopus").feet).toBe("none")
  })

  it("gives the blob max roundness and the robot the least", () => {
    expect(getSpeciesTraits("blob").roundness).toBe(1)
    expect(getSpeciesTraits("robot").roundness).toBeLessThan(getSpeciesTraits("blob").roundness)
  })
})
