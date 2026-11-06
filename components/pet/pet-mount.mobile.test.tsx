import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import DefaultPetMount, { PetMount } from "./pet-mount.mobile"

describe("PetMount mobile compilation boundary", () => {
  it("mounts no desktop or browser lifecycle on Capacitor", () => {
    const { container } = render(<PetMount />)
    expect(container).toBeEmptyDOMElement()
  })

  it("is the default export too, which the pet's effect entry loads", () => {
    // `components/pet/module.ui.ts` imports `./pet-mount`, which the Capacitor
    // build resolves to this file.
    expect(DefaultPetMount).toBe(PetMount)
  })

  it("keeps non-mobile runtime dependencies outside the compilation graph", () => {
    const source = readFileSync(join(__dirname, "pet-mount.mobile.tsx"), "utf8")
    expect(source).not.toMatch(/(?:^import |\bimport\(|\brequire\()/m)
  })
})
