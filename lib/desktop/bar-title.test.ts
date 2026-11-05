import { resolveBarTitle } from "./bar-title"

test("the chat home is about the active conversation", () => {
  expect(resolveBarTitle("/", "Refactor the parser")).toEqual({
    kind: "conversation",
    label: "Refactor the parser",
  })
})

test("an untitled conversation is still the chat home's subject", () => {
  expect(resolveBarTitle("/", null)).toEqual({ kind: "conversation", label: null })
  expect(resolveBarTitle("/", "   ")).toEqual({ kind: "conversation", label: null })
})

test("another page is named by its rail label, not by the last conversation", () => {
  expect(resolveBarTitle("/workflows", "Refactor the parser")).toEqual({
    kind: "page",
    labelKey: "desktop.guildRail.workflows",
  })
})

test("a nested route is named by the page it belongs to", () => {
  expect(resolveBarTitle("/inbox/123", null)).toEqual({
    kind: "page",
    labelKey: "desktop.guildRail.inbox",
  })
})

test("Settings is a page even though the rail catalog does not list it", () => {
  expect(resolveBarTitle("/settings", "Chat")).toEqual({
    kind: "page",
    labelKey: "desktop.guildRail.settings",
  })
  expect(resolveBarTitle("/settings/about", "Chat")).toEqual({
    kind: "page",
    labelKey: "desktop.guildRail.settings",
  })
})

test("a route the rail does not list is named by the app alone", () => {
  expect(resolveBarTitle("/onboarding", "Chat")).toEqual({ kind: "app" })
  // A prefix is not a match: `/settingsfoo` is not Settings.
  expect(resolveBarTitle("/settingsfoo", "Chat")).toEqual({ kind: "app" })
})

test("a module's destination is named by its own full label key", () => {
  // Squads contributes its rail entry from `lib/squads/module.ts`.
  expect(resolveBarTitle("/squads/abc", null)).toEqual({
    kind: "page",
    labelKey: "squads.nav.label",
  })
})
