import {
  ARCHIVED_COLLAPSE_PREFIX,
  collapseKeyForView,
  collapseOverridesForView,
  everywhereSearchQuery,
} from "./conversation-archive-view"
import { parseGlobalSearchQuery } from "@/lib/global-search/query-parser"

describe("collapseKeyForView", () => {
  it("stores the active view's folds under the plain section key", () => {
    expect(collapseKeyForView("team:t1", "active")).toBe("team:t1")
  })

  it("stores the archive's folds under their own prefix", () => {
    expect(collapseKeyForView("team:t1", "archived")).toBe(`${ARCHIVED_COLLAPSE_PREFIX}team:t1`)
  })
})

describe("collapseOverridesForView", () => {
  const stored = {
    "team:t1": true,
    "workspace:w1": false,
    [`${ARCHIVED_COLLAPSE_PREFIX}team:t1`]: false,
    [`${ARCHIVED_COLLAPSE_PREFIX}team:t2`]: true,
  }

  it("hands the active view the stored map unchanged", () => {
    expect(collapseOverridesForView(stored, "active")).toBe(stored)
  })

  it("hands the archive only its own choices, unprefixed", () => {
    expect(collapseOverridesForView(stored, "archived")).toEqual({
      "team:t1": false,
      "team:t2": true,
    })
  })

  it("starts the archive from the defaults when it has no choices yet", () => {
    expect(collapseOverridesForView({ "team:t1": true }, "archived")).toEqual({})
  })
})

describe("everywhereSearchQuery", () => {
  it("hands the archive and every workspace on with the words, as the button promises", () => {
    expect(everywhereSearchQuery("  deploy  ", { multipleWorkspaces: true })).toBe(
      "is:archived workspace:all deploy"
    )
  })

  it("leaves the workspace token out when there is only one workspace", () => {
    expect(everywhereSearchQuery("deploy", { multipleWorkspaces: false })).toBe(
      "is:archived deploy"
    )
  })

  it("still states the reach for an empty field, so the palette opens wide", () => {
    expect(everywhereSearchQuery("   ", { multipleWorkspaces: true })).toBe(
      "is:archived workspace:all"
    )
  })

  it("parses to the reach it names in the palette", () => {
    const parsed = parseGlobalSearchQuery(
      everywhereSearchQuery("deploy", { multipleWorkspaces: true })
    )
    expect(parsed.filters).toMatchObject({ archived: true, workspace: "all" })
    expect(parsed.text).toBe("deploy")
  })
})
