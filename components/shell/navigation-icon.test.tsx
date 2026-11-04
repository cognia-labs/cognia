/** @jest-environment jsdom */
import { act, render, renderHook } from "@testing-library/react"
import { CompassIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"
import { GLANCE_MODULE_IDS } from "@/types/glance/layout"
import {
  NavigationIcon,
  TeamNavigationIcon,
  useIllustratedNavigationIcons,
} from "./navigation-icon"

beforeEach(() => {
  useSettingsStore.setState({ settings: null })
})

it.each([
  ...SIDEBAR_NAV_META.map((item) => item.id),
  ...GLANCE_MODULE_IDS.map((id) => `glance:${id}`),
  "chat",
  "canvas",
  "settings",
])("defaults %s to decorative anime artwork", (id) => {
  const { container } = render(<NavigationIcon id={id} fallback={CompassIcon} />)
  expect(container.querySelector("[data-navigation-artwork]")).toHaveAttribute(
    "aria-hidden",
    "true"
  )
  expect(container.querySelector("img")).toHaveAttribute("width", "28")
  expect(container.querySelector("img")).toHaveClass("size-full", "shrink-0")
})

it("updates live in both directions using the existing preference", () => {
  const { container } = render(
    <NavigationIcon id="discover" fallback={CompassIcon} className="size-4 text-muted-foreground" />
  )
  act(() => useSettingsStore.setState({ settings: { settingsIconStyle: "ordinary" } as never }))
  expect(container.querySelector("img")).toBeNull()
  expect(container.querySelector("svg")).toHaveClass("lucide-compass", "size-4")
  act(() => useSettingsStore.setState({ settings: { settingsIconStyle: "anime" } as never }))
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "/icons/cognia-mobile-spots/png/discover.png"
  )
})

it("preserves unregistered icons", () => {
  const { container } = render(<NavigationIcon id="third-party:tool" fallback={CompassIcon} />)
  expect(container.querySelector("img")).toBeNull()
  expect(container.querySelector("svg")).toHaveClass("lucide-compass")
})

it("themes dynamic plugin entries and preserves their ordinary fallback", () => {
  const { container } = render(
    <NavigationIcon id="third-party:tool" defaultArtwork="plugins" fallback={<CompassIcon />} />
  )
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "/icons/cognia-mobile-spots/webp/plugins.webp"
  )
  act(() => useSettingsStore.setState({ settings: { settingsIconStyle: "ordinary" } as never }))
  expect(container.querySelector("img")).toBeNull()
  expect(container.querySelector("svg")).toHaveClass("lucide-compass")
})

it.each([
  ["team_builtin_brainstorm", "png/skills.png"],
  ["team_builtin_code_review_pair", "webp/source-control.webp"],
  ["team_builtin_doc_polishers", "webp/instructions.webp"],
  ["team_builtin_research_squad", "png/discover.png"],
  ["custom-team", "webp/teams.webp"],
])("themes team %s and restores its saved avatar live", (id, path) => {
  const { container } = render(
    <TeamNavigationIcon team={{ id, name: "Team", avatarEmoji: "🧠" }} />
  )
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    `/icons/cognia-mobile-spots/${path}`
  )
  act(() => useSettingsStore.setState({ settings: { settingsIconStyle: "ordinary" } as never }))
  expect(container.querySelector("img")).toBeNull()
  expect(container).toHaveTextContent("🧠")
  act(() => useSettingsStore.setState({ settings: { settingsIconStyle: "anime" } as never }))
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    `/icons/cognia-mobile-spots/${path}`
  )
})

it("preserves an explicitly chosen team image in anime mode", () => {
  const { container } = render(
    <TeamNavigationIcon
      team={{ id: "custom", name: "Team", avatarImageUrl: "data:image/png;base64,AAA" }}
    />
  )
  expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AAA")
  expect(container.querySelector("[data-navigation-artwork]")).toBeNull()
})

it("reports the icon style a host should lay its tiles out for", () => {
  const { result } = renderHook(() => useIllustratedNavigationIcons())
  // No saved preference reads as illustrated, like `NavigationIcon` itself.
  expect(result.current).toBe(true)
  act(() => useSettingsStore.setState({ settings: { settingsIconStyle: "ordinary" } as never }))
  expect(result.current).toBe(false)
  act(() => useSettingsStore.setState({ settings: { settingsIconStyle: "anime" } as never }))
  expect(result.current).toBe(true)
})
