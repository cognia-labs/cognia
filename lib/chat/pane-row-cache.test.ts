import type { ChatSession } from "@cognia/agent-config-types"

import {
  PANE_ROW_CACHE_LIMIT,
  clearPaneRowCache,
  readCachedPaneRows,
  rememberPaneRows,
} from "./pane-row-cache"

const row = (id: string, title = id) => ({ id, title }) as unknown as ChatSession

describe("pane row cache", () => {
  afterEach(() => clearPaneRowCache())

  it("serves remembered rows in the requested order, only when all are cached", () => {
    rememberPaneRows("scope", ["a", "b"], [row("a"), row("b")])
    expect(readCachedPaneRows("scope", ["b", "a"])?.map((r) => r.id)).toEqual(["b", "a"])
    expect(readCachedPaneRows("scope", ["a", "c"])).toBeUndefined()
    expect(readCachedPaneRows("scope", [])).toBeUndefined()
  })

  it("keeps scopes apart", () => {
    rememberPaneRows("host-1", ["a"], [row("a")])
    expect(readCachedPaneRows("host-2", ["a"])).toBeUndefined()
  })

  it("replaces a row with the newer read and forgets requested rows that are gone", () => {
    rememberPaneRows("scope", ["a"], [row("a", "old")])
    rememberPaneRows("scope", ["a"], [row("a", "new")])
    expect(readCachedPaneRows("scope", ["a"])?.[0]?.title).toBe("new")
    rememberPaneRows("scope", ["a"], [])
    expect(readCachedPaneRows("scope", ["a"])).toBeUndefined()
  })

  it("drops the least recently read rows past the limit", () => {
    for (let i = 0; i <= PANE_ROW_CACHE_LIMIT; i++)
      rememberPaneRows("scope", [`s${i}`], [row(`s${i}`)])
    expect(readCachedPaneRows("scope", ["s0"])).toBeUndefined()
    expect(readCachedPaneRows("scope", [`s${PANE_ROW_CACHE_LIMIT}`])).toBeDefined()
  })
})
