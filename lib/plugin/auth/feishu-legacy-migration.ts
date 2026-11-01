/** Host-only migration boundary: legacy app secrets never enter the replacement plugin. */
import type {
  AuthConnectionRef,
  AuthCredentialSet,
  AuthIdentityDescription,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getSecret, clearSecret } from "@/lib/keyring"
import { getInstallEncryptionPassphrase } from "@/lib/data/backup-key"
import { setWebKeyringPassphrase } from "@/lib/keyring"
import { isPluginGatewayAvailable } from "@/lib/plugin/core/transport"
import { transport } from "@/lib/tauri/transport-instance"
import { ConnectionIdentityConflict, getConnectionManager } from "./connection-manager"
import {
  authConnectionIdentityKey,
  findAuthConnection,
  listAuthConnections,
} from "@/lib/db/auth-connections"
import type { AuthenticationProvider } from "./auth-provider-registry"
import { getProvider } from "./auth-provider-registry"
import { accountAuthSecrets, withAuthLock } from "./connection-credentials"
import { setProviderClientSecret } from "./client-secrets"

const PLUGIN = "feishu-auth"
const LEDGER = "migration:feishu-auth:host-v1"
const INDEX = "cognia.plugin-secrets-index.feishu-auth"
interface LegacyRecord {
  version: number
  session: {
    id: string
    accessToken: string
    account: { id: string; label: string }
    scopes: string[]
  }
  configuration: { clientId: string; clientSecret?: string }
  refreshToken?: string
  expiresAt: number
}
interface Receipt {
  ref?: AuthConnectionRef
  /** Encrypted Host backup, deliberately excluding the app secret. Survives audit pruning. */
  credentials?: AuthCredentialSet
  description: AuthIdentityDescription
  phase: "exchanging" | "exchanged" | "ready" | "completed"
  needsReauth?: boolean
}
type Ledger = Record<string, Receipt>

/** Runs at Host-managed registration; session reads await it before exposing connections. */
export async function migrateFeishuLegacySessions(provider: AuthenticationProvider): Promise<void> {
  if (provider.pluginId !== PLUGIN || provider.id !== "feishu-user-oauth") return
  await withAuthLock(
    "cognia-auth-migration:feishu-auth",
    async () => {
      const active = () => {
        if (getProvider(provider.id) !== provider)
          throw new Error("Auth provider changed during migration")
      }
      active()
      // Match the backend used by the old ctx.secrets. These are Host store
      // operations, not plugin gateway calls requiring now-removed permissions.
      const remote = isPluginGatewayAvailable()
      const readLegacy = (key: string) =>
        remote
          ? transport.call<string | null>("secret_store_get", {
              input: { namespace: `plugin:${PLUGIN}`, key },
            })
          : getSecret({ namespace: `plugin:${PLUGIN}`, key }, { strict: true })
      const deleteLegacy = (key: string) =>
        remote
          ? transport.call<void>("secret_store_delete", {
              input: { namespace: `plugin:${PLUGIN}`, key },
            })
          : clearSecret({ namespace: `plugin:${PLUGIN}`, key }, { strict: true })
      const retireLegacy = async (key: string) => {
        for (const previous of await listAuthConnections(provider.id)) {
          if (previous.legacySessionId === key.slice("oauth-session:".length))
            await getConnectionManager().disconnect(previous.id, { revoke: false })
        }
        await deleteLegacy(key)
      }
      const secrets = accountAuthSecrets("auth-connections")
      let ledgerRaw = await secrets.read(LEDGER)
      const ledger: Ledger = ledgerRaw ? JSON.parse(ledgerRaw) : {}
      const save = async () => {
        const next = JSON.stringify(ledger)
        await secrets.compareAndSet(LEDGER, ledgerRaw, next, true)
        ledgerRaw = next
      }
      const rawIndex = typeof localStorage === "undefined" ? null : localStorage.getItem(INDEX)
      const keys: unknown = rawIndex ? JSON.parse(rawIndex) : []
      if (!Array.isArray(keys)) throw new Error("Invalid legacy auth inventory")
      if (!keys.some((key) => typeof key === "string" && key.startsWith("oauth-session:"))) return
      if (!remote) {
        const passphrase = await getInstallEncryptionPassphrase()
        if (passphrase) setWebKeyringPassphrase(passphrase)
      }
      for (const key of keys) {
        if (typeof key !== "string" || !key.startsWith("oauth-session:")) continue
        active()
        if (ledger[key]?.phase === "completed") {
          await retireLegacy(key)
          continue
        }
        const raw = await readLegacy(key)
        if (!raw) continue
        const record = JSON.parse(raw) as LegacyRecord
        const clientId = record.configuration?.clientId
        const account = record.session?.account
        if (
          record.version !== 1 ||
          record.session?.id !== key.slice("oauth-session:".length) ||
          typeof clientId !== "string" ||
          !clientId ||
          typeof account?.id !== "string" ||
          !account.id.startsWith(`${clientId}:`) ||
          !account.id.slice(clientId.length + 1) ||
          typeof account.label !== "string" ||
          typeof record.session.accessToken !== "string" ||
          !record.session.accessToken ||
          !Array.isArray(record.session.scopes) ||
          record.session.scopes.some((scope) => typeof scope !== "string") ||
          (record.refreshToken !== undefined && typeof record.refreshToken !== "string") ||
          (record.configuration.clientSecret !== undefined &&
            typeof record.configuration.clientSecret !== "string") ||
          !Number.isFinite(record.expiresAt)
        )
          throw new Error("Invalid legacy Feishu session; original retained")
        const issuer = "https://accounts.feishu.cn" // The old provider supported only Feishu.
        // The legacy open id is already known. Refuse another provider's
        // lineage before rotating any token, not just at metadata publication.
        const existing = await findAuthConnection(
          authConnectionIdentityKey({
            issuer,
            clientId,
            principal: { id: account.id.slice(clientId.length + 1), kind: "user" },
          })
        )
        if (
          existing &&
          existing.status !== "tombstoned" &&
          existing.status !== "revoked" &&
          (existing.providerId !== provider.id || existing.ownerPluginId !== provider.pluginId)
        )
          throw new ConnectionIdentityConflict()
        if (record.configuration.clientSecret)
          await setProviderClientSecret(
            PLUGIN,
            provider.id,
            clientId,
            record.configuration.clientSecret,
            issuer
          )
        let credentials: AuthCredentialSet = ledger[key]?.credentials ?? {
          accessToken: record.session.accessToken,
          refreshToken: record.refreshToken,
          scopes: [...record.session.scopes],
          expiresAt: new Date(record.expiresAt).toISOString(),
          extra: { clientId, issuer, principalKind: "user" },
        }
        let description: AuthIdentityDescription = ledger[key]?.description ?? {
          issuer,
          clientId,
          principal: { id: account.id.slice(clientId.length + 1), kind: "user" },
          accountLabel: account.label,
          scopes: [...record.session.scopes],
        }
        // A prior interrupted exchange may have rotated the token remotely. Do
        // not retry it: preserve a recovery connection instead of guessing.
        let needsReauth =
          ledger[key]?.phase === "exchanging" ||
          ledger[key]?.needsReauth === true ||
          !credentials.refreshToken
        if (!ledger[key]) {
          ledger[key] = { credentials, description, phase: "exchanging" }
          await save()
          try {
            if (credentials.refreshToken)
              credentials = await provider.refresh!({
                ref: record.session.id as AuthConnectionRef,
                lineageId: record.session.id,
                credentialRevision: 0,
                identity: {
                  ...description,
                  provider: {
                    providerId: provider.id,
                    ownerPluginId: PLUGIN,
                    publisher: null,
                    contractMajor: 1,
                  },
                },
                credentials,
              })
            active()
            // Persist returned rotations before any more network work or publication.
            ledger[key] = { credentials, description, phase: "exchanged", needsReauth }
            await save()
          } catch {
            needsReauth = true
          }
        }
        if (ledger[key]?.phase !== "ready") {
          active()
          try {
            description = await provider.describe!(credentials)
          } catch {
            needsReauth = true
          }
          ledger[key] = { credentials, description, phase: "ready", needsReauth }
          await save()
        }
        active()
        const connection = await getConnectionManager().importLegacyCredentials(
          provider,
          description,
          credentials,
          needsReauth
        )
        ledger[key] = { description, ref: connection, phase: "completed" }
        await save()
        // Completion evidence and Host credentials are durable before deleting the old record.
        await retireLegacy(key)
      }
    },
    "migration"
  )
}

export async function feishuLegacySessionAliases(
  provider: AuthenticationProvider
): Promise<Map<string, AuthConnectionRef>> {
  if (provider.pluginId !== PLUGIN || provider.id !== "feishu-user-oauth") return new Map()
  const raw = await accountAuthSecrets("auth-connections").read(LEDGER)
  const ledger: Ledger = raw ? JSON.parse(raw) : {}
  return new Map(
    Object.entries(ledger).flatMap(([key, receipt]) =>
      receipt.phase === "completed" && receipt.ref
        ? [[key.slice("oauth-session:".length), receipt.ref] as const]
        : []
    )
  )
}
