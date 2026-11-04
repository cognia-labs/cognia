import { createKimiSessionCatalog } from "./session-catalog"

it("reconciles acknowledged deletions only in their workspace and expires stale markers", () => {
  let now = 1000
  const catalog = createKimiSessionCatalog(() => now)
  catalog.deleted("gone", "/work")
  expect(catalog.listed([{ sessionId: "gone" }], { cwd: "/work" })).toEqual([])
  catalog.listed([], { cwd: "/other" })
  expect(catalog.listed([{ sessionId: "gone" }])).toEqual([])
  catalog.listed([], { cwd: "/work" })
  expect(catalog.listed([{ sessionId: "gone" }])).toEqual([{ sessionId: "gone" }])
  catalog.deleted("late")
  now += 120001
  expect(catalog.listed([{ sessionId: "late" }])).toEqual([{ sessionId: "late" }])
})

it("bounds retained deletions and clears the package-owned state", () => {
  const catalog = createKimiSessionCatalog(() => 0)
  for (let i = 0; i < 257; i++) catalog.deleted(String(i))
  const rows = [{ sessionId: "0" }, { sessionId: "256" }]
  expect(catalog.listed(rows)).toEqual([{ sessionId: "0" }])
  catalog.clear()
  expect(catalog.listed(rows)).toEqual(rows)
})
