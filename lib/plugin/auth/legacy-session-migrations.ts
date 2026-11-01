import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type { AuthenticationProvider } from "./auth-provider-registry"
import { migrateFeishuLegacySessions, feishuLegacySessionAliases } from "./feishu-legacy-migration"

/** Host-only handover hooks. The migrator owns its durable completion ledger. */
export interface LegacySessionMigration {
  migrate(provider: AuthenticationProvider): Promise<void>
  aliases(provider: AuthenticationProvider): Promise<Map<string, AuthConnectionRef>>
}

const migrations = new Map<string, LegacySessionMigration>()
const keyFor = (pluginId: string | null, providerId: string) =>
  JSON.stringify([pluginId, providerId])

export function registerLegacySessionMigration(
  pluginId: string,
  providerId: string,
  migration: LegacySessionMigration
): () => void {
  const key = keyFor(pluginId, providerId)
  if (migrations.has(key)) throw new Error("Legacy session migrator already registered")
  migrations.set(key, migration)
  return () => {
    if (migrations.get(key) === migration) migrations.delete(key)
  }
}

/** Await handover before accepting a new grant or exposing provider sessions. */
export async function runLegacySessionMigrations(provider: AuthenticationProvider): Promise<void> {
  await migrations.get(keyFor(provider.pluginId, provider.id))?.migrate(provider)
}

/** Read after handover; providers without a registered migrator have no aliases. */
export async function legacySessionAliases(
  provider: AuthenticationProvider
): Promise<Map<string, AuthConnectionRef>> {
  return (
    (await migrations.get(keyFor(provider.pluginId, provider.id))?.aliases(provider)) ?? new Map()
  )
}

// Single Host built-ins registration point. Generic dispatch above is vendor-independent.
const builtins: Array<[string, string, LegacySessionMigration]> = [
  [
    "feishu-auth",
    "feishu-user-oauth",
    {
      migrate: migrateFeishuLegacySessions,
      aliases: feishuLegacySessionAliases,
    },
  ],
]
for (const [pluginId, providerId, migration] of builtins)
  registerLegacySessionMigration(pluginId, providerId, migration)
