/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const toggleDesktopPetWindow = jest.fn()
jest.mock("@/lib/pet/commands", () => ({
  toggleDesktopPetWindow: () => toggleDesktopPetWindow(),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (message: string) => toastError(message) } }))

const requestOpenSettings = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: { requestOpenSettings: jest.Mock }) => unknown) =>
    selector({ requestOpenSettings }),
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))

let mockPlatform: "tauri" | "web" | "mobile" = "tauri"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockPlatform }))

let mockPetEnabled = true
let mockOnDesktop = true
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: {
        petSettings: { enabled: mockPetEnabled, desktopPet: { enabled: mockOnDesktop } },
      },
    }),
}))

import { TitleBarQuickActions } from "./title-bar-quick-actions"

beforeEach(() => {
  mockOnDesktop = true
  toggleDesktopPetWindow.mockReset().mockResolvedValue(false)
  toastError.mockClear()
  requestOpenSettings.mockClear()
  routerPush.mockClear()
  mockPlatform = "tauri"
  mockPetEnabled = true
})

describe("TitleBarQuickActions", () => {
  it("puts the desktop pet away through the shared, persisted toggle", async () => {
    render(<TitleBarQuickActions />)
    const pet = screen.getByTestId("quick-action-pet")
    expect(pet).toHaveAttribute("aria-pressed", "true")
    expect(pet).toHaveAttribute("aria-label", "hidePet")
    await act(async () => {
      fireEvent.click(pet)
    })
    expect(toggleDesktopPetWindow).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it("sends the pet out to the desktop when it is away", async () => {
    mockOnDesktop = false
    toggleDesktopPetWindow.mockResolvedValue(true)
    render(<TitleBarQuickActions />)
    const pet = screen.getByTestId("quick-action-pet")
    expect(pet).toHaveAttribute("aria-pressed", "false")
    expect(pet).toHaveAttribute("aria-label", "showPet")
    await act(async () => {
      fireEvent.click(pet)
    })
    expect(toggleDesktopPetWindow).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it("says so when the pet would not come out", async () => {
    mockOnDesktop = false
    toggleDesktopPetWindow.mockResolvedValue(false)
    render(<TitleBarQuickActions />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-action-pet"))
    })
    expect(toastError).toHaveBeenCalledWith("petToggleFailed")
  })

  it("recovers from a toggle that throws", async () => {
    toggleDesktopPetWindow.mockRejectedValue(new Error("ipc"))
    render(<TitleBarQuickActions />)
    const pet = screen.getByTestId("quick-action-pet")
    await act(async () => {
      fireEvent.click(pet)
    })
    expect(toastError).toHaveBeenCalledWith("petToggleFailed")
    expect(pet).not.toBeDisabled()
  })

  it("opens OCR settings", () => {
    render(<TitleBarQuickActions />)
    fireEvent.click(screen.getByTestId("quick-action-ocr"))
    expect(requestOpenSettings).toHaveBeenCalledWith("ocr")
  })

  it("opens the capture settings where they live: the pet console's Insights", () => {
    // Settings → Pet has no capture controls; `CaptureSettingsPanel` is mounted
    // only in the console's Insights (inside Activity).
    render(<TitleBarQuickActions />)
    fireEvent.click(screen.getByTestId("quick-action-capture"))
    expect(routerPush).toHaveBeenCalledWith("/pet?tab=insights")
    expect(requestOpenSettings).not.toHaveBeenCalled()
  })

  it("does not offer a pet toggle for a pet that is switched off", () => {
    mockPetEnabled = false
    render(<TitleBarQuickActions />)
    expect(screen.queryByTestId("quick-action-pet")).toBeNull()
    expect(screen.getByTestId("quick-action-capture")).toBeInTheDocument()
  })

  it.each(["web", "mobile"] as const)(
    "keeps only OCR on %s, where the pet and its console cannot run (ADR-0058 D9)",
    (platform) => {
      mockPlatform = platform
      render(<TitleBarQuickActions />)
      expect(screen.queryByTestId("quick-action-pet")).toBeNull()
      expect(screen.queryByTestId("quick-action-capture")).toBeNull()
      expect(screen.getByTestId("quick-action-ocr")).toBeInTheDocument()
    }
  )
})
