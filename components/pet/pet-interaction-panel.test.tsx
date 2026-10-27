import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// Stub the renderer so the stat-card preview's resolved skin is observable
// without mounting the live2d skin (stores + canvas) in this unit test.
jest.mock("./pet-renderer", () => ({
  PetRenderer: ({ skinId }: { skinId?: string }) => (
    <div data-testid="pet-preview" data-skin={skinId ?? "default"} />
  ),
}))

// The cooldown gate's reactive read: nothing cooling.
jest.mock("@/hooks/pet/use-action-cooldown", () => ({
  useActionCooldown: () => ({ remaining: () => 0 }),
}))

import { PetInteractionPanel } from "./pet-interaction-panel"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetProfile } from "@/types/pet"

function makeProfile(): PetProfile {
  return {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
    xp: 150,
    level: 2,
  }
}

function setup(props: { skinId?: string } = {}) {
  const profile = makeProfile()
  const view = computePetView(profile, null, 0)
  const handlers = { onCare: jest.fn(), onTalk: jest.fn() }
  const utils = render(
    <PetInteractionPanel profile={profile} view={view} {...handlers} {...props} />
  )
  return { ...handlers, ...utils, profile, view }
}

describe("PetInteractionPanel", () => {
  beforeEach(() => {
    window.localStorage.clear()
    usePetStore.setState({ interactionRefusal: null })
  })

  it("reads like a mini Home: who, what it needs most, care, talk", () => {
    setup()
    const panel = screen.getByTestId("pet-interaction-panel")
    expect(panel).toHaveClass("max-h-[calc(100dvh-2rem)]")
    const order = ["pet-stat-card", "pet-vitals-card", "pet-care-suggestion", "pet-action-grid"]
      .map((id) => screen.getByTestId(id))
      .concat(screen.getByTestId("pet-talk-composer"))
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
    for (const need of ["energy", "mood", "bond"]) {
      expect(document.querySelector(`[data-need="${need}"]`)).not.toBeNull()
    }
  })

  it("has no inventory, plugin slot, wallet jump or quick-nav (main-window only)", () => {
    setup()
    expect(screen.queryByTestId("pet-inventory-strip")).toBeNull()
    expect(screen.queryByTestId("pet-wallet-strip")).toBeNull()
    expect(screen.queryByTestId("pet-quick-nav")).toBeNull()
  })

  it("forwards skinId to the stat-card preview (defaults to SVG)", () => {
    const { rerender, profile, view, onCare, onTalk } = setup()
    expect(screen.getByTestId("pet-preview").dataset.skin).toBe("default")
    rerender(
      <PetInteractionPanel
        profile={profile}
        view={view}
        onCare={onCare}
        onTalk={onTalk}
        skinId="live2d"
      />
    )
    expect(screen.getByTestId("pet-preview").dataset.skin).toBe("live2d")
  })

  it("runs each care action, including the suggested one", () => {
    const h = setup()
    for (const kind of ["fed", "played", "petted", "slept", "cleaned", "treated"]) {
      fireEvent.click(
        screen.getByTestId("pet-action-grid").querySelector(`[data-action="${kind}"]`) as Element
      )
      expect(h.onCare).toHaveBeenLastCalledWith(kind)
    }
    const suggestion = screen.queryByTestId("pet-care-suggestion-action")
    if (suggestion) {
      fireEvent.click(suggestion)
      expect(h.onCare).toHaveBeenLastCalledWith(suggestion.getAttribute("data-action"))
    }
  })

  it("keeps the talk field on the card without stealing focus", async () => {
    const h = setup()
    // The grid has no talk toggle: the field is always there.
    expect(screen.queryByLabelText(/^talk$|actions\.talk/i)).toBeNull()
    const input = screen.getByPlaceholderText("Say something to your pet…")
    expect(input).not.toHaveFocus()
    fireEvent.change(input, { target: { value: "  hi Boba  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(h.onTalk).toHaveBeenCalledWith("hi Boba"))
    await waitFor(() => expect(input).toHaveValue(""))
  })

  it("submits bare talk (no text) as undefined via the send button", async () => {
    const h = setup()
    fireEvent.click(screen.getByLabelText("Send"))
    await waitFor(() => expect(h.onTalk).toHaveBeenCalledWith(undefined))
  })

  it("forwards every action without gating it locally", () => {
    // Enforcement belongs to the controller (lib/pet/runtime/pet-controller.test.ts).
    const h = setup()
    const sleepBtn = screen
      .getByTestId("pet-action-grid")
      .querySelector('[data-action="slept"]') as HTMLButtonElement
    fireEvent.click(sleepBtn)
    fireEvent.click(sleepBtn)
    expect(h.onCare.mock.calls.filter(([kind]) => kind === "slept")).toHaveLength(2)
  })
})
