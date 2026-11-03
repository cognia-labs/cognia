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
    pullPage: async () => ({ items: [], cursor: "next" }),
    confirmDeparted: async (_binding: unknown, ids: string[]) => ids,
    completeFullScan: true,
    fullScanOnly: true,
  }
  expect(defineIssueSyncProvider(provider)).toBe(provider)
  const bound = { ...provider, connectionRef: "host-connection" as never }
  expect(defineIssueSyncProvider(bound).connectionRef).toBe("host-connection")
  expect(() => defineIssueSyncProvider({ ...provider, connectionRef: "" as never })).toThrow(
    /connectionRef/
  )
  expect(defineIssueSyncProvider(provider).pullPage).toBe(provider.pullPage)
  expect(defineIssueSyncProvider(provider).confirmDeparted).toBe(provider.confirmDeparted)
  expect(() => defineIssueSyncProvider({ ...provider, confirmDeparted: true } as never)).toThrow()
  expect(() => defineIssueSyncProvider({ ...provider, pullPage: undefined })).toThrow(/pullPage/)
  expect(await defineIssueSyncProvider(provider).pull()).toEqual({ items: [], notModified: true })
})
