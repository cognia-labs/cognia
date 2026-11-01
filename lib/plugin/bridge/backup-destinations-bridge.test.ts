import {
  registerBackupDestinationsForPlugin,
  unregisterBackupDestinationsForPlugin,
} from "./backup-destinations-bridge"
import { createBackupAPI } from "@/lib/plugin/api/backup-api"
import { getBackupDestination } from "@/lib/data/destinations/registry"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"
import type { PluginManifest } from "@cognia/plugin-contract/types/plugin/plugin"

it("validates descriptors and tears down imperative registrations on disable", () => {
  const manifest = {
    id: "bridge-test",
    backupDestinations: [{ id: "archive", label: "Archive" }],
  } as PluginManifest
  resetPermissionGuard()
  getPermissionGuard().registerPlugin(manifest.id, ["backup:destination"])
  const api = createBackupAPI(manifest.id, manifest)
  registerBackupDestinationsForPlugin(manifest)
  const input = {
    id: "archive",
    label: "Archive",
    readiness: async () => ({ state: "ready" as const }),
    upload: jest.fn(),
  }
  const registration = api.registerDestination(input)
  expect(getBackupDestination(registration.destinationId)).toBeDefined()
  unregisterBackupDestinationsForPlugin(manifest.id)
  unregisterBackupDestinationsForPlugin(manifest.id)
  expect(getBackupDestination(registration.destinationId)).toBeUndefined()
  expect(() => api.registerDestination(input)).toThrow(/activation/)
  expect(() =>
    registerBackupDestinationsForPlugin({
      ...manifest,
      backupDestinations: [{ id: "webdav", label: "Bad" }],
    })
  ).toThrow(/reserved/)
})
