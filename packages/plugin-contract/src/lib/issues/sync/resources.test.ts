import {
  assertPortableIssueSyncConfig,
  canonicalIssueSyncConfig,
  validatePluginIssueSyncProviderDef,
  pluginResourceForStorage,
} from "./resources"

it("keeps a portable capture handle while excluding device-local connection metadata", () => {
  const saved = pluginResourceForStorage({
    kind: "plugin",
    providerId: "plugin:tracker/issues",
    schemaVersion: 1,
    config: { project: "one" },
    captureId: "random-capture",
    connectionRef: "private",
  } as never)
  expect(saved).toMatchObject({ captureId: "random-capture" })
  expect(saved).not.toHaveProperty("connectionRef")
})

it("validates a declaration and refuses namespaced ids and invalid versions", () => {
  expect(
    validatePluginIssueSyncProviderDef({ id: "github", label: "Tracker", schemaVersion: 1 })
  ).toEqual([])
  for (const patch of [
    { id: "plugin:other/github" },
    { id: "" },
    { label: "" },
    { schemaVersion: 0 },
    { schemaVersion: 1.5 },
  ])
    expect(
      validatePluginIssueSyncProviderDef({
        id: "tracker",
        label: "Tracker",
        schemaVersion: 1,
        ...patch,
      }).length
    ).toBeGreaterThan(0)
})

it("canonicalizes nested JSON and refuses nonportable identity and credentials", () => {
  expect(canonicalIssueSyncConfig({ b: 2, a: { z: 1, a: ["one"] } })).toBe(
    canonicalIssueSyncConfig({ a: { a: ["one"], z: 1 }, b: 2 })
  )
  expect(() =>
    assertPortableIssueSyncConfig({ project: "a", mapping: { title: "Summary" } })
  ).not.toThrow()
  for (const key of [
    "connectionRef",
    "connection_id",
    "accountId",
    "adapterId",
    "token",
    "accessToken",
    "clientSecret",
  ])
    expect(() => assertPortableIssueSyncConfig({ nested: [{ [key]: "private" }] })).toThrow(
      /portable/
    )
  expect(() => canonicalIssueSyncConfig({ invalid: undefined })).toThrow(/JSON/)
})
