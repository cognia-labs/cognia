import {
  isDocsProviderUrlOrigin,
  isPluginDocsProviderId,
  validatePluginDocsProviderDef,
} from "./plugin-docs-providers"

const definition = {
  id: "docs",
  label: "Acme Docs",
  mentionPrefix: "acme.docs:",
  kinds: ["doc"],
  urlOrigins: ["https://docs.example.test"],
}

it("accepts only namespaced provider ids", () => {
  expect(isPluginDocsProviderId("plugin:acme/docs")).toBe(true)
  for (const id of [
    "lark",
    "plugin:acme",
    "plugin:/docs",
    "plugin:acme/../docs",
    "plugin:acme/docs/extra",
  ])
    expect(isPluginDocsProviderId(id)).toBe(false)
})

it.each([
  "http://docs.example.test",
  "https://user@docs.example.test",
  "https://docs.example.test/",
  "https://docs.example.test/path",
  "javascript:alert(1)",
])("rejects non-origin or non-HTTPS addresses: %s", (origin) => {
  expect(isDocsProviderUrlOrigin(origin)).toBe(false)
  expect(
    validatePluginDocsProviderDef({ ...definition, urlOrigins: [origin] }, "acme")
  ).not.toEqual([])
})

it("requires a plugin-owned namespace and valid kinds", () => {
  expect(validatePluginDocsProviderDef(definition, "acme")).toEqual([])
  for (const mentionPrefix of ["lark:", "google:", "gdoc:", "other.docs:", "acme.docs", "acme.:"])
    expect(validatePluginDocsProviderDef({ ...definition, mentionPrefix }, "acme")).not.toEqual([])
  expect(validatePluginDocsProviderDef({ ...definition, kinds: ["slides"] }, "acme")).not.toEqual(
    []
  )
})
