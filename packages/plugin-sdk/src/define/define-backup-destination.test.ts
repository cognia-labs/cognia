import { defineBackupDestination } from "./define-backup-destination"

it("preserves the typed contribution and optional restore operations", async () => {
  const destination = {
    id: "archive",
    label: "Archive",
    readiness: async () => ({ state: "ready" as const }),
    upload: async () => ({ remoteId: "one", bytes: 4 }),
    list: async () => [{ remoteId: "one", label: "One" }],
  }
  expect(defineBackupDestination(destination)).toBe(destination)
  expect(await defineBackupDestination(destination).list()).toEqual([
    { remoteId: "one", label: "One" },
  ])
})
