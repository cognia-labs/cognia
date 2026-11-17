import { render, screen } from "@testing-library/react"

import type { ResolvedComposerSkin } from "@/lib/chat/composer-skin"

import { ComposerRunStatusStrip } from "./composer-run-status-strip"

it("insets the strip by the card's corner radius and rounds its own corners to match", () => {
  const skin = { isClassic: false, radiusPx: 20 } as ResolvedComposerSkin
  render(
    <ComposerRunStatusStrip skin={skin} compactLayout={false}>
      <span>running</span>
    </ComposerRunStatusStrip>
  )

  const strip = screen.getByText("running").parentElement as HTMLElement
  expect(strip).toHaveAttribute("data-slot", "composer-run-status")
  expect(strip.style.paddingInline).toBe("20px")
  expect(strip.style.getPropertyValue("--run-strip-radius")).toBe("12px")
})
