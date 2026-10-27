import { fireEvent, render, screen, waitFor } from "@testing-library/react"

// Stub the renderer so we don't mount the SVG/live2d skin in this unit test.
jest.mock("../pet-renderer", () => ({
  PetRenderer: ({ size, mood, lowPower }: { size?: number; mood?: string; lowPower?: boolean }) => (
    <div
      data-testid="pet-preview"
      data-size={size}
      data-mood={mood}
      data-low-power={lowPower || undefined}
    />
  ),
}))
// Inventory strip's reactive read: empty so the strip stays hidden here.
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))
jest.mock("@/hooks/pet/use-action-cooldown", () => ({
  useActionCooldown: () => ({ remaining: () => 0 }),
}))
const slotProps = jest.fn()
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: (props: unknown) => {
    slotProps(props)
    return <div data-testid="plugin-slot" />
  },
}))

import { HomeTab, type HomeTabProps } from "./home-tab"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetProfile } from "@/types/pet"

function setup(
  over: Partial<HomeTabProps> = {},
  needs?: { energy: number; mood: number; bond: number }
) {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
    xp: 150,
    level: 2,
  }
  const base = computePetView(profile, null, 0)
  const view = needs ? { ...base, needs: { ...base.needs, ...needs } } : base
  const handlers = {
    onCare: jest.fn(),
    onTalk: jest.fn(),
    onOpenShop: jest.fn(),
    onOpenChat: jest.fn(),
  }
  render(<HomeTab profile={profile} view={view} lowPower {...handlers} {...over} />)
  return handlers
}

beforeEach(() => {
  usePetStore.setState({ interactionRefusal: null })
  slotProps.mockClear()
  window.localStorage.clear()
})

describe("HomeTab", () => {
  it("shows the pet on the stage with its needs, beside what to do next", () => {
    setup()
    const hero = screen.getAllByTestId("pet-preview").find((node) => node.dataset.size === "160")
    expect(screen.getByTestId("pet-home-stage")).toContainElement(hero as HTMLElement)
    expect(hero).toHaveAttribute("data-low-power", "true")
    for (const need of ["energy", "mood", "bond"]) {
      expect(document.querySelector(`[data-need="${need}"]`)).not.toBeNull()
    }
    expect(screen.getByTestId("pet-stat-card")).toBeInTheDocument()
  })

  it("opens on the most-needed care, above every other action", () => {
    const h = setup({}, { energy: 12, mood: 80, bond: 80 })
    const next = screen.getByTestId("pet-home-next")
    const grid = screen.getByTestId("pet-action-grid")
    expect(next.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByTestId("pet-care-suggestion-action"))
    expect(h.onCare).toHaveBeenCalledWith("slept")
  })

  it("wires the six care actions, without a talk toggle beside the talk field", () => {
    const h = setup()
    for (const kind of ["fed", "played", "petted", "slept", "cleaned", "treated"]) {
      fireEvent.click(
        screen.getByTestId("pet-action-grid").querySelector(`[data-action="${kind}"]`) as Element
      )
      expect(h.onCare).toHaveBeenLastCalledWith(kind)
    }
    expect(screen.queryByRole("button", { name: /^talk$/i })).toBeNull()
  })

  it("keeps a quick-talk field on the page that does not steal focus", async () => {
    const h = setup()
    const input = screen.getByPlaceholderText("Say something to your pet…")
    expect(input).not.toHaveFocus()
    fireEvent.change(input, { target: { value: "hi" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(h.onTalk).toHaveBeenCalledWith("hi"))
  })

  it("leads to the full conversation and to the shop", () => {
    const h = setup()
    fireEvent.click(screen.getByTestId("pet-home-open-chat"))
    expect(h.onOpenChat).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("pet-wallet-strip"))
    expect(h.onOpenShop).toHaveBeenCalledTimes(1)
  })

  it("hosts plugin care actions with the safe context bag", () => {
    setup()
    expect(slotProps).toHaveBeenCalledWith(
      expect.objectContaining({
        point: "pet.panel.actions",
        context: expect.objectContaining({ level: 2, stage: "baby" }),
      })
    )
  })

  it("makes talk a care tap and drops plugins when caring remotely", () => {
    const h = setup({ talkMode: "direct", showPluginActions: false })
    expect(screen.queryByTestId("pet-talk-composer")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /^talk$/i }))
    expect(h.onTalk).toHaveBeenCalledWith()
    expect(slotProps).not.toHaveBeenCalled()
  })

  it("renders a notice above the columns when given", () => {
    setup({ notice: <p data-testid="skin-note" /> })
    expect(screen.getByTestId("skin-note")).toBeInTheDocument()
  })
})
