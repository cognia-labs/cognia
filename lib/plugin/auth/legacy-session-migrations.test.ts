import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type { AuthenticationProvider } from "./auth-provider-registry"
import {
  legacySessionAliases,
  registerLegacySessionMigration,
  runLegacySessionMigrations,
  type LegacySessionMigration,
} from "./legacy-session-migrations"

const provider: AuthenticationProvider = {
  id: "registry-provider",
  pluginId: "registry-owner",
  label: "Registry provider",
  getSessions: async () => [],
  createSession: jest.fn(),
  removeSession: async () => {},
}
const ref = "connection-ref" as AuthConnectionRef
function migrator(): LegacySessionMigration {
  return {
    migrate: jest.fn(async () => {}),
    aliases: jest.fn(async () => new Map([["old-session", ref]])),
  }
}

it.each([null, "unregistered-owner"])(
  "does nothing for unregistered owner %p",
  async (pluginId) => {
    const unregistered = { ...provider, pluginId }
    await expect(runLegacySessionMigrations(unregistered)).resolves.toBeUndefined()
    const aliases = await legacySessionAliases(unregistered)
    expect(aliases).toEqual(new Map())
    aliases.set("local-only", ref)
    expect(await legacySessionAliases(unregistered)).toEqual(new Map())
  }
)

it("matches both plugin and provider ids and passes through the provider and aliases", async () => {
  const migration = migrator()
  const dispose = registerLegacySessionMigration(provider.pluginId!, provider.id, migration)
  try {
    await runLegacySessionMigrations({ ...provider, pluginId: "other-owner" })
    await runLegacySessionMigrations({ ...provider, id: "other-provider" })
    expect(await legacySessionAliases({ ...provider, pluginId: "other-owner" })).toEqual(new Map())
    expect(await legacySessionAliases({ ...provider, id: "other-provider" })).toEqual(new Map())
    expect(migration.migrate).not.toHaveBeenCalled()
    expect(migration.aliases).not.toHaveBeenCalled()
    await runLegacySessionMigrations(provider)
    expect(migration.migrate).toHaveBeenCalledWith(provider)
    expect(await legacySessionAliases(provider)).toEqual(new Map([["old-session", ref]]))
    expect(migration.aliases).toHaveBeenCalledWith(provider)
  } finally {
    dispose()
  }
})

it("awaits migration completion before the caller reads aliases", async () => {
  const events: string[] = []
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const dispose = registerLegacySessionMigration(provider.pluginId!, provider.id, {
    async migrate() {
      events.push("start")
      await gate
      events.push("complete")
    },
    async aliases() {
      events.push("aliases")
      return new Map([["old-session", ref]])
    },
  })
  try {
    const handover = (async () => {
      await runLegacySessionMigrations(provider)
      return legacySessionAliases(provider)
    })()
    expect(events).toEqual(["start"])
    finish()
    await expect(handover).resolves.toEqual(new Map([["old-session", ref]]))
    expect(events).toEqual(["start", "complete", "aliases"])
  } finally {
    finish()
    dispose()
  }
})

it.each(["migrate", "aliases"] as const)("propagates %s errors unchanged", async (method) => {
  const failure = new Error("migration failed")
  const migration = migrator()
  migration[method] = jest.fn(async () => {
    throw failure
  })
  const dispose = registerLegacySessionMigration(provider.pluginId!, provider.id, migration)
  try {
    await expect(
      method === "migrate" ? runLegacySessionMigrations(provider) : legacySessionAliases(provider)
    ).rejects.toBe(failure)
  } finally {
    dispose()
  }
})

it("rejects duplicate registration and lets a disposed pair be registered again", async () => {
  const first = migrator()
  const second = migrator()
  const dispose = registerLegacySessionMigration(provider.pluginId!, provider.id, first)
  try {
    expect(() => registerLegacySessionMigration(provider.pluginId!, provider.id, second)).toThrow(
      "already registered"
    )
  } finally {
    dispose()
  }
  const removeSecond = registerLegacySessionMigration(provider.pluginId!, provider.id, second)
  try {
    dispose()
    await runLegacySessionMigrations(provider)
    expect(second.migrate).toHaveBeenCalledWith(provider)
  } finally {
    removeSecond()
  }
  await runLegacySessionMigrations(provider)
  expect(second.migrate).toHaveBeenCalledTimes(1)
  expect(await legacySessionAliases(provider)).toEqual(new Map())
})
