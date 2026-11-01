import { pluginResourceState } from "./plugin-resources"
import { IssueSyncRegistry } from "./registry"
import type { IssueSyncProvider, IssueSyncResourceDescriptor } from "./types"
import type { IssueProjectResource } from "@/types/issues"

const resource: Extract<IssueProjectResource, { kind: "plugin" }> = {
  kind: "plugin",
  providerId: "plugin:acme/tracker",
  schemaVersion: 1,
  config: { project: "a" },
}
const provider: IssueSyncProvider = {
  id: resource.providerId,
  label: "Tracker",
  pullFields: [],
  pushFields: [],
  resource: {
    label: "Tracker",
    schemaVersion: 2,
    schema: { type: "object", properties: {} },
    describe: (config) => ({ key: String(config.project), label: String(config.project) }),
    migrate: (_version, config) => ({ ...config, migrated: true }),
  },
  resolveBindings: () => [],
  pull: async () => ({ items: [], notModified: true }),
}

it("migrates only the working copy, preserving the binding identity and stored config", () => {
  const registry = new IssueSyncRegistry()
  registry.register(provider)
  const state = pluginResourceState(resource, registry)
  expect(state.status).toBe("ready")
  if (state.status !== "ready") throw new Error("expected ready")
  expect(state.resource.config).toEqual({ project: "a", migrated: true })
  expect(state.key).toBe("plugin:acme/tracker:a")
  expect(resource.config).toEqual({ project: "a" })
  expect(resource.schemaVersion).toBe(1)
})

it("keeps an unavailable resource and rejects missing/failed migration or a newer version", () => {
  const registry = new IssueSyncRegistry()
  expect(pluginResourceState(resource, registry).status).toBe("unavailable")
  for (const migrate of [
    undefined,
    () => {
      throw new Error("bad migration")
    },
  ]) {
    registry.register({ ...provider, resource: { ...provider.resource!, migrate } })
    expect(pluginResourceState(resource, registry).status).toBe("needs-attention")
  }
  registry.register(provider)
  expect(pluginResourceState({ ...resource, schemaVersion: 3 }, registry).status).toBe(
    "needs-attention"
  )
  expect(resource.config).toEqual({ project: "a" })
})

it("requires schema, mapping, custom validation and a valid description before syncing", () => {
  const registry = new IssueSyncRegistry()
  const patches: Partial<IssueSyncResourceDescriptor>[] = [
    {
      schema: {
        type: "object" as const,
        properties: { required: { type: "string" as const } },
        required: ["required"],
      },
    },
    {
      schema: {
        type: "object" as const,
        properties: {},
        mapping: {
          type: "object" as const,
          properties: { title: { type: "string" as const } },
          required: ["title"],
        },
      },
    },
    { validate: () => ["Invalid remote project"] },
    { describe: () => ({ key: "", label: "Invalid" }) },
  ]
  for (const patch of patches) {
    registry.register({ ...provider, resource: { ...provider.resource!, ...patch } })
    expect(pluginResourceState(resource, registry).status).toBe("needs-attention")
  }
})
