import { render } from "@testing-library/react"
import { PetEyesGroup, PetMouth } from "./pet-face"
import type { PetEyes } from "@/types/pet"
import type { PetMouthShape } from "@/lib/pet/animation/motion-spec"

const EYES: PetEyes[] = ["dot", "sleepy", "wide", "wink", "star", "spiral"]
const MOUTHS: PetMouthShape[] = ["neutral", "smile", "grin", "open", "frown", "flat", "o"]

describe("PetEyesGroup", () => {
  it("renders every eye shape with a data-eyes marker", () => {
    for (const kind of EYES) {
      const { container, unmount } = render(
        <svg>
          <PetEyesGroup kind={kind} />
        </svg>
      )
      expect(container.querySelector(`[data-eyes="${kind}"]`)).not.toBeNull()
      unmount()
    }
  })
})

describe("PetMouth", () => {
  it("renders every mouth shape with a data-mouth marker", () => {
    for (const shape of MOUTHS) {
      const { container, unmount } = render(
        <svg>
          <PetMouth shape={shape} />
        </svg>
      )
      expect(container.querySelector(`[data-mouth="${shape}"]`)).not.toBeNull()
      unmount()
    }
  })
})

describe("eye catchlights", () => {
  it("lights the open eyes and leaves the closed ones dark", () => {
    const lit = (kind: PetEyes) => {
      const { container, unmount } = render(
        <svg>
          <PetEyesGroup kind={kind} />
        </svg>
      )
      const n = container.querySelectorAll('[data-pet-part="catchlight"]').length
      unmount()
      return n
    }
    expect(lit("dot")).toBe(2)
    expect(lit("wide")).toBe(2)
    expect(lit("sleepy")).toBe(0)
    expect(lit("star")).toBe(0)
  })
})
