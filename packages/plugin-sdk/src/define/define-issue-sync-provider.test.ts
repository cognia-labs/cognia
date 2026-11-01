import { defineIssueSyncProvider } from "./define-issue-sync-provider"

it("preserves the schema and callbacks without importing Host code", async () => {
  const provider = {
    id: "tracker",
    label: "Tracker",
    pullFields: [] as const,
    pushFields: [] as const,
    resource: {
      label: "Tracker",
      schemaVersion: 1,
      schema: { type: "object" as const, properties: { project: { type: "string" as const } } },
      describe: (config: Record<string, unknown>) => ({
        key: String(config.project),
        label: String(config.project),
      }),
    },
    pull: async () => ({ items: [], notModified: true }),
  }
  expect(defineIssueSyncProvider(provider)).toBe(provider)
  expect(await defineIssueSyncProvider(provider).pull()).toEqual({ items: [], notModified: true })
})
