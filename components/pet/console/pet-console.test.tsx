import {
  render as rtlRender,
  screen,
  within,
  fireEvent,
  act,
  type RenderOptions,
} from "@testing-library/react"
import type { ReactElement } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"

// The header's controls use tooltips; the app mounts the provider globally in
// `app/layout.tsx`.
const render = (ui: ReactElement, options?: RenderOptions) =>
  rtlRender(ui, { wrapper: TooltipProvider, ...options })

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
// The detail pane crossfades between places; the fade itself is not under test.
jest.mock("@/components/settings/common/panel-transition", () => ({
  PanelTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("@/hooks/pet/use-active-character-id", () => ({
  useActiveCharacterId: () => "char-1",
}))
const chatTabProps = jest.fn()
jest.mock("./chat-tab", () => ({
  ChatTab: (props: unknown) => {
    chatTabProps(props)
    return <div data-testid="tab-chat" />
  },
}))

const mockUsePlatform = jest.fn(() => "tauri")
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => mockUsePlatform(),
}))

jest.mock("@/hooks/pet/use-pet")
let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (s: (x: unknown) => unknown) => s({ settings: settingsValue }),
}))

// Live2D model probe — default: no model, core not ready → effective skin "svg".
const useActiveLive2dModel = jest.fn(() => ({
  modelId: undefined as string | undefined,
  row: undefined,
  coreReady: false as boolean | undefined,
}))
const useActiveSpritePack = jest.fn(() => ({
  packId: undefined as string | undefined,
  row: undefined as { id: string } | undefined,
}))
jest.mock("@/hooks/pet/use-active-sprite-pack", () => ({
  useActiveSpritePack: () => useActiveSpritePack(),
}))
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => useActiveLive2dModel(),
}))

// Capture renderer props (also intercepts NurtureTab's hero renderer — same module).
const rendererProps = jest.fn()
jest.mock("../pet-renderer", () => ({
  PetRenderer: (props: unknown) => {
    rendererProps(props)
    return <div data-testid="pet-renderer-stub" />
  },
}))
const hatchPetOnce = jest.fn()
const renamePet = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/pet/runtime/hatch", () => ({
  hatchPetOnce: (settings: unknown) => hatchPetOnce(settings),
}))
jest.mock("@/lib/pet/runtime/rename-pet", () => ({
  renamePet: (name: string) => renamePet(name),
  sanitizePetName: (s: string) => s.trim(),
  isValidPetName: (s: string) => s.trim().length > 0,
  MAX_PET_NAME: 24,
}))
const toggleDesktopPetWindow = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/pet/commands", () => ({
  toggleDesktopPetWindow: () => toggleDesktopPetWindow(),
}))
jest.mock("./dex-tab", () => ({ DexTab: () => <div data-testid="tab-dex" /> }))
jest.mock("./shop-tab", () => ({ ShopTab: () => <div data-testid="tab-shop" /> }))

// Nurture tab's inventory strip reads Dexie reactively — keep it empty here.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}))

// Plugin slot host — controllable "has extensions" flag + a stub mount.
let hasPluginExtensions = false
const slotProps = jest.fn()
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  usePluginSlotHasExtensions: () => hasPluginExtensions,
  PluginExtensionSlot: (props: unknown) => {
    slotProps(props)
    return <div data-testid="pet-plugin-slot" />
  },
}))
jest.mock("./achievements-tab", () => ({ AchievementsTab: () => <div data-testid="tab-ach" /> }))
jest.mock("./journal-tab", () => ({ JournalTab: () => <div data-testid="tab-journal" /> }))
jest.mock("./insights-tab", () => ({ InsightsTab: () => <div data-testid="tab-insights" /> }))
const bindingProps = jest.fn()
jest.mock("./binding-tab", () => ({
  BindingTab: (props: unknown) => {
    bindingProps(props)
    return <div data-testid="tab-bind" />
  },
}))
jest.mock("@/components/pet/settings/pet-customization-workspace", () => ({
  PetCustomizationWorkspace: () => <div data-testid="pet-customization-workspace" />,
}))
jest.mock("@/components/platform/capability-gate", () => ({
  CapabilityGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { toast } from "sonner"
import { usePet } from "@/hooks/pet/use-pet"
import { resolvePetConsoleTarget } from "@/lib/pet/console-tabs"
import { PetConsole } from "./pet-console"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"
import { getPetSkinRuntime, resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"

const mockUsePet = usePet as jest.Mock

/** Pick a row of the console's rail. */
const pick = (id: string) => fireEvent.click(screen.getByTestId(`pet-console-nav-item-${id}`))

function petResult(soul: PetProfile["soul"]) {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul,
    stage: soul ? "baby" : "egg",
  }
  return {
    profile,
    view: computePetView(profile, null, 0),
    loading: false,
    feed: jest.fn(),
    play: jest.fn(),
    petStroke: jest.fn(),
    talk: jest.fn(),
  }
}

beforeEach(() => {
  mockUsePlatform.mockReturnValue("tauri")
  resetPetSkinRuntimeForTests()
  mockUsePet.mockReset()
  hatchPetOnce.mockReset()
  hatchPetOnce.mockResolvedValue({ status: "hatched", profile: {} })
  renamePet.mockReset()
  renamePet.mockResolvedValue(undefined)
  chatTabProps.mockClear()
  ;(toast.error as jest.Mock).mockClear()
  rendererProps.mockClear()
  slotProps.mockClear()
  bindingProps.mockClear()
  hasPluginExtensions = false
  settingsValue = {}
  toggleDesktopPetWindow.mockReset()
  toggleDesktopPetWindow.mockResolvedValue(true)
  useActiveLive2dModel.mockReset()
  useActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: false })
  useActiveSpritePack.mockReset()
  useActiveSpritePack.mockReturnValue({ packId: undefined, row: undefined })
})

describe("PetConsole", () => {
  it("shows loading until the pet is ready", () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    render(<PetConsole />)
    expect(screen.getByTestId("pet-console-loading")).toBeInTheDocument()
  })

  it("keeps the same hooks when the profile finishes loading after mount", () => {
    // The regression pin: the desktop toggle's state hook sat after the
    // loading return, so the first render with a profile threw "Rendered
    // more hooks than during the previous render".
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    const { rerender } = render(<PetConsole />)
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    rerender(<PetConsole />)
    expect(screen.getByTestId("pet-console")).toBeInTheDocument()
    expect(screen.getByTestId("pet-console-desktop-toggle")).toBeInTheDocument()
  })

  it("offers a hatch action for an unhatched egg, through the single-flight hatch", async () => {
    settingsValue = { defaultProvider: "openai" }
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-hatch")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /hatch|console\.hatch/i }))
    })
    expect(hatchPetOnce).toHaveBeenCalledWith({ defaultProvider: "openai" })
  })

  it("toasts a hatch that failed", async () => {
    hatchPetOnce.mockResolvedValue({ status: "failed", error: new Error("x") })
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /hatch|console\.hatch/i }))
    })
    expect(toast.error).toHaveBeenCalled()
  })

  it("reads the pet through the open session's character and names it in chat", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole initialTarget={resolvePetConsoleTarget("chat")} />)
    expect(mockUsePet).toHaveBeenCalledWith("char-1")
    // The chat itself reads the character through the console's actions.
    expect(chatTabProps).toHaveBeenCalledWith({ petName: "Boba" })
  })

  it("runs in local mode on the desktop, with nothing labelled desktop-only", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-console")).toHaveAttribute("data-mode", "local")
    expect(document.querySelector("[data-nav-badge]")).toBeNull()
    expect(screen.queryByTestId("pet-remote-status-band")).toBeNull()
    expect(screen.queryByTestId("pet-console-desktop-status")).toBeNull()
  })

  it("opens on Home for a hatched pet and moves between the five places", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-home-tab")).toBeInTheDocument()
    const clickTab = pick
    // The segments are Radix tabs, which activate on mousedown, not on click.
    const clickSegment = (id: string) =>
      fireEvent.mouseDown(document.querySelector(`[data-segment="${id}"]`) as Element)
    clickTab("shop")
    expect(screen.getByTestId("tab-shop")).toBeInTheDocument()
    clickTab("collection")
    expect(screen.getByTestId("tab-dex")).toBeInTheDocument()
    clickSegment("achievements")
    expect(screen.getByTestId("tab-ach")).toBeInTheDocument()
    clickTab("activity")
    expect(screen.getByTestId("tab-journal")).toBeInTheDocument()
    clickSegment("insights")
    expect(screen.getByTestId("tab-insights")).toBeInTheDocument()
    // Each section keeps its own segment.
    clickTab("collection")
    expect(screen.getByTestId("tab-ach")).toBeInTheDocument()
  })

  it("is a settings list-and-detail frame, the pet's identity heading the detail card", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    // Settings → Pet (ADR-0058 D16) owns the page chrome and the wallpaper
    // marker, so the console brings no feature shell of its own.
    expect(screen.queryByTestId("feature-shell-pet")).not.toBeInTheDocument()
    expect(screen.queryByTestId("pet-console-frame")).not.toBeInTheDocument()
    const detail = screen.getByTestId("pet-console-detail")
    expect(detail).toContainElement(screen.getByTestId("pet-console-header"))
    expect(detail).toContainElement(screen.getByTestId("pet-console-pane"))
    expect(screen.getByTestId("pet-console-header")).toHaveAttribute(
      "data-slot",
      "feature-page-header"
    )
    // The settings shell's header is the page's h1.
    expect(screen.getByRole("heading", { level: 2, name: /Boba/ })).toBeInTheDocument()
    // The header carries no navigation: the rail does.
    expect(screen.queryByRole("tablist", { name: /pet navigation/i })).toBeNull()
  })

  it("lists the places on the rail, Appearance & settings last, and marks the open one", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    const rail = screen.getByRole("list", { name: /pet navigation/i })
    const rows = within(rail).getAllByRole("button")
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "pet-console-nav-item-home",
      "pet-console-nav-item-chat",
      "pet-console-nav-item-shop",
      "pet-console-nav-item-collection",
      "pet-console-nav-item-activity",
      "pet-console-nav-item-appearance",
    ])
    expect(screen.getByTestId("pet-console-nav-item-home")).toHaveAttribute("aria-current", "true")
    pick("shop")
    expect(screen.getByTestId("pet-console-nav-item-shop")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("pet-console-nav-item-home")).not.toHaveAttribute("aria-current")
    expect(screen.getByTestId("pet-console")).toHaveAttribute("data-place", "shop")
    expect(screen.getByTestId("pet-console-pane")).toHaveAccessibleName("Shop")
  })

  it("opens at the deep-linked target and follows later deep links", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    const { rerender } = render(<PetConsole initialTarget={resolvePetConsoleTarget("dex")} />)
    expect(screen.getByTestId("tab-dex")).toBeInTheDocument()
    rerender(<PetConsole initialTarget={resolvePetConsoleTarget("achievements")} />)
    expect(screen.getByTestId("tab-ach")).toBeInTheDocument()
    rerender(<PetConsole initialTarget={resolvePetConsoleTarget("insights")} />)
    expect(screen.getByTestId("tab-insights")).toBeInTheDocument()
  })

  it("keeps the reader's place when the same target is rebuilt", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    const { rerender } = render(<PetConsole initialTarget={resolvePetConsoleTarget("home")} />)
    pick("shop")
    // A new object naming the same place is not a new deep link.
    rerender(<PetConsole initialTarget={resolvePetConsoleTarget("home")} />)
    expect(screen.getByTestId("tab-shop")).toBeInTheDocument()
  })

  it("jumps from Home's wallet strip to the shop and from talk to the chat", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    fireEvent.click(screen.getByTestId("pet-wallet-strip"))
    expect(screen.getByTestId("tab-shop")).toBeInTheDocument()
    pick("home")
    fireEvent.click(screen.getByTestId("pet-home-open-chat"))
    expect(screen.getByTestId("tab-chat")).toBeInTheDocument()
  })

  it("opens Appearance & settings from the rail, with the pet still heading the card", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    pick("shop")
    pick("appearance")
    expect(screen.getByTestId("pet-console")).toHaveAttribute("data-view", "appearance")
    expect(screen.getByTestId("pet-console-nav-item-appearance")).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(screen.getByTestId("pet-customization-workspace")).toBeInTheDocument()
    expect(screen.getByTestId("tab-bind")).toBeInTheDocument()
    expect(bindingProps).toHaveBeenLastCalledWith({ readOnly: false })
    // No sub-page: the identity header stays and there is no back button.
    expect(screen.getByTestId("pet-console-desktop-toggle")).toBeInTheDocument()
    expect(screen.queryByTestId("pet-console-back")).toBeNull()
    pick("shop")
    expect(screen.getByTestId("tab-shop")).toBeInTheDocument()
  })

  it("lands an earlier layout's customize and binding links on Appearance & settings", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    const { rerender } = render(<PetConsole initialTarget={resolvePetConsoleTarget("customize")} />)
    expect(screen.getByTestId("pet-appearance-view")).toBeInTheDocument()
    rerender(<PetConsole initialTarget={resolvePetConsoleTarget("nurture")} />)
    expect(screen.getByTestId("pet-home-tab")).toBeInTheDocument()
  })

  it("resolves the effective skin and passes it to the header renderer and Home", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    useActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    settingsValue = { petSettings: { skinId: "live2d" } }
    render(<PetConsole />)
    // Header avatar + Home hero both go through the mocked renderer.
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ skinId: "live2d" }))
    expect(rendererProps).not.toHaveBeenCalledWith(expect.objectContaining({ skinId: "svg" }))
  })

  it("falls back to the svg skin when the Live2D core is not ready", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    settingsValue = { petSettings: { skinId: "live2d" } }
    render(<PetConsole />)
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ skinId: "svg" }))
    // Home explains why the built-in mascot is showing.
    expect(screen.getByText(/requested skin.*live2d/i)).toBeInTheDocument()
    expect(screen.getByText(/effective skin.*vector mascot/i)).toBeInTheDocument()
  })

  it("omits the fallback note once Live2D renders", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    useActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    settingsValue = { petSettings: { skinId: "live2d" } }
    render(<PetConsole />)
    expect(screen.queryByText(/fallback is active/i)).toBeNull()
  })

  it("offers a functional retry after repeated WebGL context loss", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    useActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    settingsValue = { petSettings: { skinId: "live2d" } }
    const runtime = getPetSkinRuntime()
    runtime.recordContextLoss("live2d:m1")
    runtime.recordContextLoss("live2d:m1")

    render(<PetConsole />)
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(runtime.assetDiagnostic("live2d:m1")).toBeUndefined()
  })

  it("offers the same runtime recovery for an active Sprite v2 pack", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    useActiveSpritePack.mockReturnValue({ packId: "s1", row: { id: "s1" } })
    settingsValue = { petSettings: { skinId: "sprite-v2" } }
    const runtime = getPetSkinRuntime()
    runtime.recordAssetFailure("sprite-v2:s1", "renderFailed")

    render(<PetConsole />)
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(runtime.assetDiagnostic("sprite-v2:s1")).toBeUndefined()
  })

  it("retries an imported animation pack from the console", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    settingsValue = { petSettings: { skinId: "media", activeMediaPackId: "mp_whale" } }
    const runtime = getPetSkinRuntime()
    runtime.recordAssetFailure("media:mp_whale", "renderFailed")
    render(<PetConsole />)
    expect(rendererProps).toHaveBeenCalledWith(
      expect.objectContaining({
        skinId: "media",
        selection: { skinId: "media", packId: "mp_whale" },
      })
    )
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(runtime.assetDiagnostic("media:mp_whale")).toBeUndefined()
  })

  it("hides the Extensions row until a pet.console.tab extension registers", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(screen.queryByTestId("pet-console-nav-item-plugins")).toBeNull()
  })

  it("shows the Extensions row before Setup and mounts the slot with the safe context bag", () => {
    hasPluginExtensions = true
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(
      within(screen.getByTestId("pet-console-nav-group-pet").parentElement as HTMLElement)
        .getAllByRole("button")
        .at(-1)
    ).toHaveAttribute("data-testid", "pet-console-nav-item-plugins")
    pick("plugins")
    expect(screen.getByTestId("pet-plugin-slot")).toBeInTheDocument()
    expect(slotProps).toHaveBeenCalledWith(
      expect.objectContaining({
        point: "pet.console.tab",
        context: expect.objectContaining({
          level: expect.any(Number),
          stage: "baby",
          mood: expect.any(String),
          condition: expect.any(String),
        }),
      })
    )
  })

  it("falls back to Home for a plugins deep link with no Extensions row yet", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole initialTarget={resolvePetConsoleTarget("plugins")} />)
    expect(screen.getByTestId("pet-home-tab")).toBeInTheDocument()
    // Home's own `pet.panel.actions` slot mounts; the console tab's does not.
    expect(slotProps).not.toHaveBeenCalledWith(
      expect.objectContaining({ point: "pet.console.tab" })
    )
  })

  it("hosts the plugin care actions on Home", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(slotProps).toHaveBeenCalledWith(
      expect.objectContaining({ point: "pet.panel.actions", limit: 4 })
    )
  })

  it("shows a layout-matched placeholder while the profile loads", () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    render(<PetConsole />)
    expect(screen.getByTestId("pet-console-loading")).toHaveAttribute("aria-busy", "true")
  })

  it("renames the pet from the header editor", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    const input = screen.getByLabelText(/pet name|pet\.rename\.label/i)
    fireEvent.change(input, { target: { value: "Mochi" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(renamePet).toHaveBeenCalledWith("Mochi")
  })
})

describe("hosts where the pet cannot run", () => {
  it.each(["web", "mobile"])(
    "asks an unpaired %s client to pair instead of spinning forever",
    (platform) => {
      // `PetMount` refuses to initialize the profile on the Capacitor shell, so
      // a phone reaching the console used to wait at a spinner that never
      // resolved.
      mockUsePlatform.mockReturnValue(platform)
      mockUsePet.mockReturnValue(petResult(null))
      render(<PetConsole />)
      const unavailable = screen.getByTestId("pet-console-unavailable")
      expect(unavailable).toHaveAttribute("data-reason", "unpaired")
      expect(unavailable).toHaveTextContent("Pair with your desktop")
      expect(screen.queryByTestId("pet-console-loading")).not.toBeInTheDocument()
    }
  )

  it("gives the unavailable page the pairing remedy and a way out", () => {
    mockUsePlatform.mockReturnValue("mobile")
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    const links = within(screen.getByTestId("pet-console-unavailable")).getAllByRole("link")
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/pair", "/"])
  })

  it("renders the console normally on a host that does run the pet", () => {
    mockUsePlatform.mockReturnValue("tauri")
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    expect(screen.queryByTestId("pet-console-unavailable")).not.toBeInTheDocument()
    expect(screen.getByTestId("pet-console")).toBeInTheDocument()
  })
})

describe("desktop toggle in the console header", () => {
  beforeEach(() => {
    settingsValue = { petSettings: { desktopPet: { enabled: false } } }
  })
  const hatched = () =>
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))

  it("offers to send a hatched pet out to the desktop", async () => {
    hatched()
    render(<PetConsole />)
    const button = screen.getByTestId("pet-console-desktop-toggle")
    expect(button).toHaveAttribute("aria-pressed", "false")
    expect(within(button).getAllByText(/Show desktop pet|quickMenu\.showDesktopPet/).length).toBe(2)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(toggleDesktopPetWindow).toHaveBeenCalledTimes(1)
  })

  it("offers to call the pet back while it is on the desktop", () => {
    hatched()
    settingsValue = { petSettings: { enabled: true, desktopPet: { enabled: true } } }
    render(<PetConsole />)
    const button = screen.getByTestId("pet-console-desktop-toggle")
    expect(button).toHaveAttribute("aria-pressed", "true")
    expect(within(button).getAllByText(/Hide desktop pet|quickMenu\.hideDesktopPet/).length).toBe(2)
  })

  it("disables itself while a toggle is in flight", async () => {
    hatched()
    let resolve!: (v: boolean) => void
    toggleDesktopPetWindow.mockReturnValueOnce(new Promise<boolean>((r) => (resolve = r)))
    render(<PetConsole />)
    const button = screen.getByTestId("pet-console-desktop-toggle")
    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).toBeDisabled()
    await act(async () => {
      resolve(true)
    })
    expect(button).not.toBeDisabled()
  })

  it("says so when the desktop pet would not open", async () => {
    hatched()
    toggleDesktopPetWindow.mockResolvedValueOnce(false)
    render(<PetConsole />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("pet-console-desktop-toggle"))
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it("recovers from a toggle that throws instead of staying disabled", async () => {
    hatched()
    toggleDesktopPetWindow.mockRejectedValueOnce(new Error("ipc"))
    render(<PetConsole />)
    const button = screen.getByTestId("pet-console-desktop-toggle")
    await act(async () => {
      fireEvent.click(button)
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(button).not.toBeDisabled()
  })

  it("is not offered for an unhatched egg", () => {
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    expect(screen.queryByTestId("pet-console-desktop-toggle")).toBeNull()
  })
})
