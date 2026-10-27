// The /pet console: a full-page home for the pet. Built on the shared
// `FeaturePageShell` + `FeaturePageHeader`, like `/memory` and
// `/conversations`: the header carries the pet's identity, the actions and the
// navigation row; the center pane scrolls and is measured as
// `@container/pet-pane`.
//
// Five places, in the order a visit goes: Home (how the pet is and what it
// needs next), Chat, Shop, Collection (dex, achievements) and Activity
// (journal, insights), plus a plugins tab while a plugin fills it. Appearance
// & settings is a sub-page the header opens, with a breadcrumb back. Where a
// link lands is `lib/pet/console-tabs.ts`.
//
// This file composes; the pieces live beside it: `PetConsoleHeader`,
// `PetConsoleNav`, `HomeTab`, `PetConsoleSegments`, `AppearanceView`,
// `HatchPanel`, `PetConsoleSkeleton`, and for remote care the status band and
// the desktop-only notice.
//
// Two modes (ADR-0219, `lib/pet/console/console-mode.ts`). In the desktop
// app's main window the console drives its own pet. On a phone or browser
// paired to a desktop that advertises `pet.remote-care`, it cares for the
// DESKTOP's pet: it paints from a mirror of the pet tables and every action
// is an RPC the desktop's controller applies. Which one runs is decided once,
// by `PetConsoleActionsProvider`, and every tab reads `usePetConsoleActions()`
// instead of reaching into the pet runtime. What only the desktop can do is
// classified in `lib/pet/console/action-capabilities.ts` and labelled here.

"use client"

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { MonitorIcon, MonitorSmartphoneIcon, PawPrintIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { usePet, type UsePetResult } from "@/hooks/pet/use-pet"
import { useActiveCharacterId } from "@/hooks/pet/use-active-character-id"
import { usePetConsoleMode } from "@/hooks/pet/use-pet-console-mode"
import { claimConnectionNotice } from "@/lib/runtime/connection-notice-claim"
import { useSettingsStore } from "@/stores/settings"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { useActiveSpritePack } from "@/hooks/pet/use-active-sprite-pack"
import {
  PluginExtensionSlot,
  usePluginSlotHasExtensions,
} from "@/components/plugins/plugin-extension-slot"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"
import type { PetAssetDiagnostic, PetSkinSelection } from "@/types/pet"
import {
  PET_CONSOLE_DEFAULT_TARGET,
  PET_CONSOLE_SECTIONS,
  isPetConsoleSection,
  type PetActivitySegment,
  type PetCollectionSegment,
  type PetConsoleSection,
  type PetConsoleTarget,
} from "@/lib/pet/console-tabs"
import { petConsoleDesktopOnlyTabs } from "@/lib/pet/console/action-capabilities"
import type { PetConsoleUnavailableReason } from "@/lib/pet/console/console-mode"
import { toPetAssetDiagnostics } from "@/lib/pet/live2d/compatibility-diagnostics"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
import { resolveEffectiveSkinSelection } from "../skins/resolve-effective-skin"
import { PetSkinStatus } from "../settings/pet-skin-status"
import { HomeTab } from "./home-tab"
import { ChatTab } from "./chat-tab"
import { ShopTab } from "./shop-tab"
import { DexTab } from "./dex-tab"
import { JournalTab } from "./journal-tab"
import { AchievementsTab } from "./achievements-tab"
import { InsightsTab } from "./insights-tab"
import { AppearanceView } from "./appearance-view"
import { PetConsoleSegments } from "./pet-console-segments"
import { PetConsoleHeader } from "./pet-console-header"
import { PetConsoleNav } from "./pet-console-nav"
import { HatchPanel } from "./hatch-panel"
import { PetConsoleSkeleton } from "./pet-console-skeleton"
import { PetConsoleActionsProvider } from "./pet-console-actions-provider"
import { usePetConsoleActions } from "./pet-console-actions-context"
import { PetRemoteStatusBand } from "./pet-remote-status-band"
import { DesktopOnlyNotice } from "./desktop-only-notice"

/** A paired device draws the plain vector pet: skins are desktop-local blobs. */
const REMOTE_SELECTION: PetSkinSelection = { skinId: "svg" }

export interface PetConsoleProps {
  /**
   * Where to open (deep link `?tab=` / `?view=`, bridge navigation), from
   * `petConsoleTargetFromParams`. Default: Home.
   */
  initialTarget?: PetConsoleTarget
}

export function PetConsole({ initialTarget }: PetConsoleProps = {}) {
  const resolution = usePetConsoleMode()
  // The console reads the pet the way the floating widget does: through the
  // open session's character binding. Without it the console showed the
  // global look while the widget beside it wore the character's, and the chat
  // tab answered without the character's persona.
  const activeCharacterId = useActiveCharacterId()
  // The pet tables are the pet's own store on the desktop and a read-only
  // mirror of the desktop's on a paired device; this reads either.
  const pet = usePet(activeCharacterId)

  if (resolution.mode === "unavailable") {
    if (resolution.reason === "host-pending") return <PetConsoleSkeleton />
    return <PetConsoleUnavailable reason={resolution.reason} />
  }

  return (
    // Keyed by mode: a device that pairs (or a desktop that starts driving a
    // remote host) gets a fresh tree rather than one carrying the other
    // mode's state.
    <PetConsoleActionsProvider
      key={resolution.mode}
      mode={resolution.mode}
      pet={pet}
      activeCharacterId={activeCharacterId}
    >
      <PetConsoleBody initialTarget={initialTarget} pet={pet} />
    </PetConsoleActionsProvider>
  )
}

/**
 * Nothing here can care for a pet. Each reason has its own remedy, because
 * "open the desktop app", "pair this phone" and "update your desktop" are
 * three different things to do.
 */
function PetConsoleUnavailable({
  reason,
}: {
  reason: Exclude<PetConsoleUnavailableReason, "host-pending">
}) {
  const t = useTranslations("pet")
  // A host without `pet_get` resolves the surface boundary to read-only, and
  // its band would say "this host can't do that" above a page that already
  // says "update your desktop app". This page is the complete report there.
  const claimsHostReport = reason === "host-without-feature"
  useEffect(() => (claimsHostReport ? claimConnectionNotice() : undefined), [claimsHostReport])
  const copy = {
    unpaired: {
      icon: MonitorSmartphoneIcon,
      title: t("console.unavailable.unpaired.title"),
      description: t("console.unavailable.unpaired.description"),
    },
    "host-without-feature": {
      icon: MonitorIcon,
      title: t("console.unavailable.hostOutdated.title"),
      description: t("console.unavailable.hostOutdated.description"),
    },
    "secondary-window": {
      icon: MonitorIcon,
      title: t("console.unavailable.title"),
      description: t("console.unavailable.secondaryWindow"),
    },
  }[reason]
  const Icon = copy.icon

  return (
    // An empty state, not a bare sentence in the top-left corner: on a phone
    // it was the only thing on the page, with nothing leading anywhere.
    <Empty
      className="h-full border-none"
      data-testid="pet-console-unavailable"
      data-reason={reason}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{copy.title}</EmptyTitle>
        <EmptyDescription>{copy.description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full max-w-xs flex-col gap-2 sm:flex-row sm:justify-center">
        {reason === "unpaired" ? (
          <Button asChild className="min-h-11 w-full sm:w-auto">
            <Link href="/pair" data-testid="pet-console-pair">
              {t("console.unavailable.unpaired.action")}
            </Link>
          </Button>
        ) : null}
        <Button
          asChild
          variant={reason === "unpaired" ? "ghost" : "outline"}
          className="min-h-11 w-full sm:w-auto"
        >
          <Link href="/">{t("console.unavailable.backToChat")}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}

function PetConsoleBody({
  initialTarget,
  pet: petState,
}: {
  initialTarget?: PetConsoleTarget
  pet: UsePetResult
}) {
  const t = useTranslations("pet")
  const actions = usePetConsoleActions()
  const remote = actions.remote
  const appSettings = useSettingsStore((s) => s.settings)
  const { profile, view } = petState
  const [target, setTarget] = useState<PetConsoleTarget>(
    initialTarget ?? PET_CONSOLE_DEFAULT_TARGET
  )
  // Each segmented section remembers its own segment while the reader moves
  // between sections.
  const [collectionSegment, setCollectionSegment] = useState<PetCollectionSegment>(
    initialTarget?.view === "main" && initialTarget.section === "collection"
      ? ((initialTarget.segment as PetCollectionSegment | undefined) ?? "dex")
      : "dex"
  )
  // Where "back" from the appearance sub-page returns to.
  const [returnSection, setReturnSection] = useState<PetConsoleSection>("home")
  const [activitySegment, setActivitySegment] = useState<PetActivitySegment>(
    initialTarget?.view === "main" && initialTarget.section === "activity"
      ? ((initialTarget.segment as PetActivitySegment | undefined) ?? "journal")
      : "journal"
  )

  // Follow later deep links too: navigating /pet?tab=shop while the console is
  // already mounted only changes the prop, not the mounted state. Adjusted
  // during render (not in an effect) per the React "derive from prop change"
  // pattern.
  // Compared by value: a caller that rebuilds the same target must not reset
  // the reader's place on every render.
  const targetKey = initialTarget ? JSON.stringify(initialTarget) : ""
  const [prevTargetKey, setPrevTargetKey] = useState(targetKey)
  if (targetKey !== prevTargetKey) {
    setPrevTargetKey(targetKey)
    if (initialTarget) {
      setTarget(initialTarget)
      if (initialTarget.view === "main" && initialTarget.segment) {
        if (initialTarget.section === "collection") {
          setCollectionSegment(initialTarget.segment as PetCollectionSegment)
        } else if (initialTarget.section === "activity") {
          setActivitySegment(initialTarget.segment as PetActivitySegment)
        }
      }
    }
  }

  // Resolve the effective skin so the console previews match the floating
  // sprite (Live2D when picked + ready, otherwise SVG) — same resolution as
  // the popup's stat-card avatar. A paired device skips it below: the skin
  // settings and assets it would read are this device's, not the desktop's.
  const pet = appSettings?.petSettings ?? DEFAULT_PET_SETTINGS
  const { modelId, row: activeModel, coreReady } = useActiveLive2dModel(pet)
  const { row: activeSpritePack } = useActiveSpritePack(pet)
  const skinResolution = resolveEffectiveSkinSelection(
    pet.skinId,
    {
      coreReady,
      hasActiveModel: Boolean(modelId),
      modelReady: activeModel?.compatibility?.status !== "invalid",
      hasActiveSpritePack: Boolean(activeSpritePack),
    },
    { modelId, packId: activeSpritePack?.id, mediaPackId: pet.activeMediaPackId }
  )
  const runtime = getPetSkinRuntime()
  useSyncExternalStore(runtime.subscribe, runtime.snapshotRevision, runtime.snapshotRevision)
  const assetKey =
    pet.skinId === "live2d" && modelId
      ? `live2d:${modelId}`
      : pet.skinId === "sprite-v2" && activeSpritePack?.id
        ? `sprite-v2:${activeSpritePack.id}`
        : pet.skinId === "media" && pet.activeMediaPackId
          ? `media:${pet.activeMediaPackId}`
          : undefined
  const diagnostics: PetAssetDiagnostic[] = [
    ...skinResolution.diagnostics,
    ...(activeModel?.compatibility
      ? toPetAssetDiagnostics(activeModel.compatibility.diagnostics)
      : []),
  ]
  const runtimeDiagnostic = assetKey ? runtime.assetDiagnostic(assetKey) : undefined
  if (runtimeDiagnostic) diagnostics.push(runtimeDiagnostic)

  // Remote care draws the plain vector pet from the desktop's mirrored bones,
  // in low power: Live2D models and sprite packs are desktop-local blobs.
  const requestedSkinId = remote
    ? (remote.snapshot?.presentation?.requestedSkinId ?? "svg")
    : (pet.skinId ?? "svg")
  const selection = remote ? REMOTE_SELECTION : skinResolution.selection
  const effectiveSkin = selection.skinId
  const lowPower = remote ? true : pet.lowPower

  // The "Plugins" tab is host-owned and appears only while ≥1 plugin has
  // registered a `pet.console.tab` extension.
  const hasPluginTabs = usePluginSlotHasExtensions("pet.console.tab")
  const sections = hasPluginTabs
    ? PET_CONSOLE_SECTIONS
    : PET_CONSOLE_SECTIONS.filter((id) => id !== "plugins")
  const desktopOnly = petConsoleDesktopOnlyTabs(actions.mode, [...sections, "insights"] as const)
  const desktopOnlySections = new Set(sections.filter((id) => desktopOnly.has(id)))
  const statusBand = remote ? <PetRemoteStatusBand remote={remote} /> : null

  if (!profile || !view) {
    // The desktop answered that it has no pet yet: nothing will ever sync, so
    // a skeleton would wait forever.
    if (remote?.snapshot && remote.snapshot.summary === null) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          {statusBand}
          <Empty className="flex-1 border-none" data-testid="pet-console-no-pet">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PawPrintIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>{t("console.remote.noPet.title")}</EmptyTitle>
              <EmptyDescription>{t("console.remote.noPet.description")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      )
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        {statusBand}
        <div className="min-h-0 flex-1">
          <PetConsoleSkeleton />
        </div>
      </div>
    )
  }

  const can = (id: Parameters<typeof actions.capability>[0]) =>
    actions.capability(id) === "available"

  // A `?tab=plugins` deep link can arrive before (or after the last of) the
  // plugins that fill it; the pane falls back to Home until one registers,
  // without forgetting that plugins is what was asked for.
  const activeSection: PetConsoleSection =
    target.view === "main" && !(target.section === "plugins" && !hasPluginTabs)
      ? target.section
      : "home"

  const openSection = (section: PetConsoleSection) => setTarget({ view: "main", section })
  const openAppearance = () => {
    if (target.view === "main") setReturnSection(activeSection)
    setTarget({ view: "appearance" })
  }

  const selectSection = (value: string) => {
    if (isPetConsoleSection(value)) openSection(value)
  }

  const desktopToggle =
    profile.soul && can("desktop.toggle")
      ? {
          onDesktop: actions.desktop.visible,
          pending: actions.desktop.pending,
          onToggle: () => void actions.toggleDesktop(),
        }
      : undefined
  // A hatched pet only: an egg on the desktop has nothing to do.
  const desktopStatus =
    profile.soul && !can("desktop.toggle") ? { visible: actions.desktop.visible } : undefined

  const headerProps = {
    profile,
    view,
    effectiveSkinId: effectiveSkin,
    selection,
    lowPower,
    onRename: (name: string) => void actions.rename(name),
    desktop: desktopToggle,
    desktopStatus,
  }

  // Why the pet looks the way it does, when it is not the look that was
  // picked: the skin fallback with its repair actions on the desktop, and the
  // simplified vector look on a paired device.
  const skinNotice =
    remote !== null ? (
      requestedSkinId !== "svg" ? (
        <p data-testid="pet-console-simplified-look" className="text-xs text-muted-foreground">
          {t("console.remote.simplifiedLook")}
        </p>
      ) : null
    ) : (
      <PetSkinStatus
        requestedSkinId={requestedSkinId}
        effectiveSkinId={effectiveSkin}
        diagnostics={diagnostics}
        onRetry={
          can("skin.retry") && runtimeDiagnostic && assetKey
            ? () => runtime.retryAsset(assetKey)
            : undefined
        }
        onConfigure={can("skin.configure") && pet.skinId !== "svg" ? openAppearance : undefined}
      />
    )

  const pane = (children: ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col">
      {statusBand}
      <main
        data-testid="pet-console-pane"
        className="@container/pet-pane min-h-0 min-w-0 flex-1 overflow-auto px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:px-6 md:py-6"
      >
        {children}
      </main>
    </div>
  )

  if (target.view === "appearance") {
    return (
      <div
        data-testid="pet-console"
        data-mode={actions.mode}
        data-view="appearance"
        className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
      >
        <FeaturePageShell
          storageId="pet-appearance"
          header={
            <PetConsoleHeader
              mode="appearance"
              {...headerProps}
              onBack={() => openSection(returnSection)}
            />
          }
        >
          {pane(
            <AppearanceView
              canCustomize={can("appearance.customize")}
              canEditBinding={can("binding.edit")}
              focus={target.focus}
            />
          )}
        </FeaturePageShell>
      </div>
    )
  }

  return (
    <Tabs
      value={activeSection}
      onValueChange={selectSection}
      data-testid="pet-console"
      data-mode={actions.mode}
      data-view="main"
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-0"
    >
      <FeaturePageShell
        storageId="pet"
        header={
          <PetConsoleHeader
            mode="main"
            {...headerProps}
            navigation={
              <PetConsoleNav sections={sections} desktopOnlySections={desktopOnlySections} />
            }
            onOpenAppearance={openAppearance}
            appearanceDesktopOnly={!can("appearance.customize")}
          />
        }
      >
        {pane(
          <>
            <TabsContent value="home">
              {profile.soul ? (
                <HomeTab
                  profile={profile}
                  view={view}
                  skinId={effectiveSkin}
                  selection={selection}
                  lowPower={lowPower}
                  onCare={(kind) => void actions.care(kind)}
                  onTalk={(text) => void actions.care("talked", text ? { text } : {})}
                  onOpenShop={() => openSection("shop")}
                  onOpenChat={() => openSection("chat")}
                  cooldownRemaining={actions.cooldownRemaining}
                  talkMode={actions.mode === "remote" ? "direct" : "composer"}
                  showPluginActions={actions.mode === "local"}
                  notice={skinNotice}
                />
              ) : (
                <HatchPanel
                  bones={view.effectiveBones}
                  skinId={effectiveSkin}
                  selection={selection}
                  lowPower={lowPower}
                  onHatch={actions.hatch}
                />
              )}
            </TabsContent>
            <TabsContent value="chat" className="h-full">
              <ChatTab petName={profile.soul?.name} />
            </TabsContent>
            <TabsContent value="shop">
              <ShopTab />
            </TabsContent>
            <TabsContent value="collection">
              <PetConsoleSegments
                testId="pet-collection"
                label={t("console.tabs.collection")}
                value={collectionSegment}
                onValueChange={setCollectionSegment}
                segments={[
                  {
                    id: "dex",
                    label: t("console.tabs.dex"),
                    content: () => <DexTab bones={view.bones} />,
                  },
                  {
                    id: "achievements",
                    label: t("console.tabs.achievements"),
                    content: () => <AchievementsTab />,
                  },
                ]}
              />
            </TabsContent>
            <TabsContent value="activity">
              <PetConsoleSegments
                testId="pet-activity"
                label={t("console.tabs.activity")}
                value={activitySegment}
                onValueChange={setActivitySegment}
                segments={[
                  {
                    id: "journal",
                    label: t("console.tabs.journal"),
                    content: () => <JournalTab />,
                  },
                  {
                    id: "insights",
                    label: t("console.tabs.insights"),
                    desktopOnly: desktopOnly.has("insights"),
                    content: () =>
                      desktopOnly.has("insights") ? (
                        <DesktopOnlyNotice tab="insights" />
                      ) : (
                        <InsightsTab />
                      ),
                  },
                ]}
              />
            </TabsContent>
            {hasPluginTabs ? (
              <TabsContent value="plugins">
                {desktopOnly.has("plugins") ? (
                  <DesktopOnlyNotice tab="plugins" />
                ) : (
                  <PluginExtensionSlot
                    point="pet.console.tab"
                    className="mx-auto flex w-full max-w-3xl flex-col gap-4"
                    context={{
                      level: profile.level,
                      stage: profile.stage,
                      mood: view.mood,
                      condition: view.condition,
                    }}
                  />
                )}
              </TabsContent>
            ) : null}
          </>
        )}
      </FeaturePageShell>
    </Tabs>
  )
}
