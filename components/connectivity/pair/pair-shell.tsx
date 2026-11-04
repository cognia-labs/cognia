"use client"

/**
 * The window `/pair` renders into — the shared guide shell (ADR-0193).
 *
 * # Why this exists
 *
 * `/pair` is a shell-bypass route (`lib/shell/bypass-routes.ts`), so nothing
 * paints behind it. The page used to be a bare `<main>` with no background of
 * its own, which meant `body[data-bg-enabled="true"]::before` — the fixed,
 * full-window wallpaper layer in `globals.css` — showed straight through under
 * the body text. `GuideShell` owns the viewport with an opaque background, so
 * the next route-level change cannot lose it again.
 *
 * # One design with `/onboarding`
 *
 * `/pair` and `/onboarding` are the same kind of screen — a full-window
 * first-contact flow — and this file used to be a hand-made copy of the
 * onboarding shell that had drifted from it: its own padding, a narrower body,
 * no entrance, a brand mark inside the panel instead of the window bar, and
 * the page title in the panel where onboarding narrates. Both now render the
 * same `components/guide/` parts: the same window bar, the same narrative
 * panel (a headline that narrates the scene, one line under it, the stepper),
 * and a step body that opens with the step's own `GuideHeading`.
 *
 * # The panel only narrates — phone and browser alike
 *
 * The browser flow used to put how-to-mint-an-invitation material in the panel
 * and switch the panel to a page-scrolling layout to fit it. Below `md` that
 * stacked a scene, a command block and a storage notice above the form, so a
 * phone-width browser opened on a screen of help with the field it came for
 * below the fold — and kept showing that help after the pairing succeeded.
 * Both clients now get the same height-capped band the phone's scan flow uses;
 * step material lives in the step body, where the coordinator mounts it only
 * on the step it belongs to.
 *
 * # It must own a definite height
 *
 * `h-[100dvh]` is only correct because `MobileShellWrapper` gives `/pair` the
 * same `flex h-[100dvh] flex-col overflow-hidden` treatment it gives
 * `/onboarding`; `GuideShell`'s `flex-1 min-h-0` is what makes one class list
 * serve that column and the bare desktop/web mount alike.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { GuideHeading } from "@/components/guide/guide-heading"
import { GuideNarrativePanel } from "@/components/guide/guide-narrative-panel"
import { GuideShell } from "@/components/guide/guide-shell"
import { GuideWindowBar, type GuideWindowBarBack } from "@/components/guide/guide-window-bar"

import { PairScene, type PairSceneState } from "./pair-scene"
import { PairStepper, type PairStep } from "./pair-stepper"

export interface PairShellProps {
  /** Which client to draw, and which copy register to use. */
  client: "web" | "mobile"
  /** Drives the scene and the panel's one line of narration. */
  sceneState: PairSceneState
  step: PairStep
  /** Steps to show in the row. The web flow has no Discover step. */
  steps?: readonly PairStep[]
  /** The step's page heading, rendered at the top of the body. */
  heading?: { title: string; description?: string }
  /** A live line about the far end (the loopback probe's verdict on web). */
  status?: ReactNode
  /** Recovery / mode context, rendered above the step body. */
  notice?: ReactNode
  /** Keys the body's entrance so only it replays on a step change. */
  bodyKey: string
  /** Leave the flow. Omitted where there is nowhere to go (a first-run gate). */
  back?: GuideWindowBarBack
  /** A pairing request is in flight; disables Back. */
  busy?: boolean
  children: ReactNode
}

export function PairShell({
  client,
  sceneState,
  step,
  steps,
  heading,
  status,
  notice,
  bodyKey,
  back,
  busy,
  children,
}: PairShellProps) {
  const t = useTranslations("mobile.pair")

  return (
    <GuideShell
      testIdPrefix="pair"
      bodyKey={bodyKey}
      dataAttributes={{ "data-client": client, "data-scene-state": sceneState }}
      windowBar={
        <GuideWindowBar wordmark={t("brandMark")} back={back} busy={busy} testIdPrefix="pair" />
      }
      panel={
        <GuideNarrativePanel
          testIdPrefix="pair"
          sceneKey={sceneState}
          scene={<PairScene state={sceneState} client={client} />}
          headline={client === "web" ? t("web.title") : t("title")}
          body={t(`narration.${sceneState}`)}
          copyKey={sceneState}
          status={status}
          stepper={<PairStepper current={step} steps={steps} />}
        />
      }
    >
      <div className="flex flex-col gap-4">
        {heading && (
          <GuideHeading title={heading.title} description={heading.description} className="mb-2" />
        )}
        {notice}
        {children}
      </div>
    </GuideShell>
  )
}
