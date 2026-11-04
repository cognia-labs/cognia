"use client"

import type { ReactNode } from "react"

import { GuideBrandMesh } from "./guide-brand-mesh"
import { GUIDE_COPY_ENTER, GUIDE_SCENE_ENTER } from "./guide-motion"
import { cn } from "@/lib/utils"

export interface GuideNarrativePanelProps {
  /** The picture. Drawn by the caller, from live state. */
  scene: ReactNode
  /** Keys the scene's crossfade. */
  sceneKey: string
  /** One line saying what this moment is about. Already translated. */
  headline: string
  /** The supporting line. Already translated. */
  body?: string
  /** Keys the copy's crossfade; defaults to the headline itself. */
  copyKey?: string
  /** A live line about the far end — rendered under the copy. */
  status?: ReactNode
  /** Progress row. Rendered in its own band at the foot of the panel. */
  stepper?: ReactNode
  /** Prefix for `${prefix}-narrative-panel`, `-scene-slot`, `-narrative-*`. */
  testIdPrefix: string
}

/**
 * The narrative half of a full-window guide (ADR-0193, generalised from
 * ADR-0141's onboarding panel).
 *
 * A brand substrate, a scene drawn from live data, a headline and one line of
 * narration, and — where the flow has steps — the progress row. `/onboarding`
 * and `/pair` are the same kind of screen, a first-contact flow that owns the
 * window, and each used to build this panel by hand: different padding,
 * different scene sizes, a page title in one and a narrator's line in the
 * other. One panel is what makes them read as one product.
 *
 * **The headline is narration, not the page title.** Each step's body opens
 * with its own `GuideHeading` (the page's `h1`); the panel says what is
 * happening in the picture. Keeping the two roles apart is what lets the panel
 * stay put while the body changes underneath it.
 *
 * **Brand colour stays off the text layer.** `--brand-action` is 1.69:1 on a
 * light substrate, so it is a mesh and a stroke here, never a text colour.
 *
 * ```
 * md and up                          below md
 * ┌──────────────┬────────────┐      ┌──────────────────────┐
 * │  mesh        │            │      │ mesh · scene · line  │  band: ~30vh
 * │  ┌────────┐  │  step body │      ├──────────────────────┤
 * │  │ scene  │  │            │      │  step body           │
 * │  └────────┘  │            │      └──────────────────────┘
 * │  headline    │            │
 * │  one line    │            │
 * │  status      │            │
 * │  ─ stepper ─ │            │
 * └──────────────┴────────────┘
 *    26rem / 30rem
 * ```
 *
 * **Below `md` it is always a height-capped band.** The panel only narrates —
 * a picture, a line, a status, the stepper — so it never needs more than a
 * band, and the step's own material (forms, how-to commands) lives in the
 * body where the user acts on it. A page-scrolling variant that let the panel
 * carry real material pushed the `/pair` form under a screen of help text on
 * a phone-width browser and is gone for that reason.
 */
export function GuideNarrativePanel({
  scene,
  sceneKey,
  headline,
  body,
  copyKey,
  status,
  stepper,
  testIdPrefix,
}: GuideNarrativePanelProps) {
  return (
    <aside
      data-testid={`${testIdPrefix}-narrative-panel`}
      className={cn(
        "relative flex w-full shrink-0 flex-col border-b border-border/60",
        // Bounded so a short viewport still leaves the step body usable.
        "h-[30vh] max-h-[15rem] min-h-[9.5rem] overflow-hidden",
        // Wide: a full-height column with a hairline trailing edge and a
        // scroll of its own.
        "md:h-auto md:max-h-none md:w-[26rem] md:overflow-y-auto md:border-r md:border-b-0 lg:w-[30rem]"
      )}
    >
      <GuideBrandMesh />

      {/* `justify-center-safe`: centred when it fits, top-aligned when the
          panel overflows — plain centring would clip the top unreachably.
          The capped band may squeeze this block (its scene shrinks to fit). */}
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-3 px-6 py-4 md:min-h-auto md:gap-7 md:px-10 md:py-12">
        <div
          key={sceneKey}
          data-testid={`${testIdPrefix}-scene-slot`}
          className={cn(
            // The band is height-capped, so the scene flexes down inside it.
            "flex min-h-0 w-full max-w-[15rem] flex-1 items-center justify-center md:max-w-[20rem] md:flex-none",
            GUIDE_SCENE_ENTER
          )}
        >
          {scene}
        </div>

        <div
          key={`${copyKey ?? headline}-copy`}
          className={cn(
            "flex w-full flex-col items-center gap-1.5 text-center md:gap-2",
            GUIDE_COPY_ENTER
          )}
        >
          <p
            className="text-balance text-sm font-medium tracking-tight text-foreground md:text-base"
            data-testid={`${testIdPrefix}-narrative-headline`}
          >
            {headline}
          </p>
          {body && (
            <p
              // The supporting line is the first thing to go when the band is
              // short — on a 375×667 phone it would push the scene out.
              className="hidden max-w-[34ch] text-balance text-xs leading-relaxed text-muted-foreground sm:block md:text-sm"
              data-testid={`${testIdPrefix}-narrative-body`}
            >
              {body}
            </p>
          )}
        </div>

        {status && <div className="flex w-full justify-center">{status}</div>}
      </div>

      {stepper && (
        <div className="relative flex shrink-0 justify-center px-6 pb-4 md:px-10 md:pb-10">
          {stepper}
        </div>
      )}
    </aside>
  )
}
