import {
  LARK_DOC_READ_SCOPES,
  LARK_SENDAS_SCOPES,
  hasLarkDocumentSearchScope,
  mergeLarkScopes,
} from "./scopes"

it("requests read-only document scopes and distinguishes search grants from IM-only grants", () => {
  expect(LARK_DOC_READ_SCOPES.split(" ").every((scope) => /:read(?:only)?$/.test(scope))).toBe(true)
  expect(LARK_DOC_READ_SCOPES.split(" ")).toContain("search:docs:read")
  expect(hasLarkDocumentSearchScope(["drive:drive:readonly"])).toBe(false)
  expect(hasLarkDocumentSearchScope(["drive:drive.search:readonly"])).toBe(true)
  expect(hasLarkDocumentSearchScope(LARK_SENDAS_SCOPES.split(" "))).toBe(false)
  expect(hasLarkDocumentSearchScope(LARK_DOC_READ_SCOPES.split(" "))).toBe(true)
  expect(hasLarkDocumentSearchScope(["search:docs:read"])).toBe(true)
  expect(hasLarkDocumentSearchScope(["drive:drive"])).toBe(true)
})

describe("mergeLarkScopes", () => {
  it("joins groups, drops repeats and blanks, and keeps first-seen order", () => {
    expect(
      mergeLarkScopes("offline_access im:message", undefined, " task:task:read  im:message ")
    ).toBe("offline_access im:message task:task:read")
    expect(mergeLarkScopes()).toBe("")
  })
})
