import { decodeMatrixVerificationPixels } from "@/lib/connectors/adapters/matrix/verification-qr"
import { createRoot } from "react-dom/client"
import { NextIntlClientProvider } from "next-intl"
import { MatrixVerificationPanel } from "@/components/settings/connections/forms/matrix-verification-panel"
import enConnections from "@/i18n/messages/en/settings/connections.json"
import zhConnections from "@/i18n/messages/zh-CN/settings/connections.json"
/** Thin browser entry: production IndexedDB, encryption and Matrix runtime. */
import { activateAccountDatabase, getDb } from "@/lib/db/schema"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  lockAccountContentCipher,
} from "@/lib/accounts/content-cipher"
import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import {
  createAdapterInstance,
  getAdapterInstance,
  patchAdapterInstanceSettings,
} from "@/lib/db/adapter-instances"
import {
  persistMatrixPendingEncryptedEvent,
  listRetryableMatrixPendingEvents,
  markMatrixPendingEventFailed,
} from "@/lib/db/matrix-pending-events"
import { createMatrixAdapter } from "@/lib/connectors/adapters/matrix"
import { connectorsHttpRequest, setConnectorCommandInvoker } from "@/lib/connectors/tauri/commands"
import type { MatrixTimelineEvent } from "@/lib/connectors/adapters/matrix/parse"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

import {
  browserVaultExists,
  provisionBrowserVault,
  unlockBrowserVault,
  getActiveBrowserVault,
  lockBrowserVault,
  changeBrowserVaultPassword,
  resetBrowserVaultPasswordWithRecoveryKey,
  BrowserVaultRepository,
  BROWSER_VAULT_DB_NAME,
} from "@/lib/runtime/browser-vault"
import { decodeBase64Url, encodeBase64Url } from "@/lib/share/encoding"

async function rawRows(databaseName: string, storeName: string): Promise<unknown[]> {
  const request = indexedDB.open(databaseName)
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const result = database.transaction(storeName, "readonly").objectStore(storeName).getAll()
    return await new Promise<unknown[]>((resolve, reject) => {
      result.onsuccess = () => resolve(result.result)
      result.onerror = () => reject(result.error)
    })
  } finally {
    database.close()
  }
}

async function closeVault(stopAdapter = true) {
  if (stopAdapter) {
    await adapter?.stop()
    adapter = undefined
  }
  getDb().close()
  lockAccountContentCipher()
  lockBrowserVault()
}
async function openVaultDatabase(accountId: string) {
  activateAccountDatabase(accountId)
  await getDb().open()
  return getDb().name
}
function activeVault() {
  const vault = getActiveBrowserVault()
  if (!vault?.isUnlocked()) throw new Error("Matrix fixture Vault is locked")
  return vault
}
const credentialName = "connector:bob:accessToken"
let credentialDecryptGate:
  { reached: Promise<void>; release: () => void; restore: () => void } | undefined

declare global {
  interface Window {
    matrixNative: <T>(name: string, args?: Record<string, unknown>) => Promise<T>
    matrixFixture: typeof fixture
  }
}
setConnectorCommandInvoker((name, args) => window.matrixNative(name, args))
let adapter: ReturnType<typeof createMatrixAdapter> | undefined
let rejectAdmission = false
let admissionRejections = 0
const events: NormalizedInboundEvent[] = []
const logs: unknown[] = []
const unsupported = async (): Promise<never> => {
  throw new Error("Not a Matrix fixture capability")
}
const fixture = {
  adapter: () => adapter,
  decodePixels: decodeMatrixVerificationPixels,
  mountVerification(locale = "en") {
    const root = document.createElement("div")
    document.body.append(root)
    createRoot(root).render(
      <NextIntlClientProvider
        locale={locale}
        messages={{ settings: { connections: locale === "en" ? enConnections : zhConnections } }}
      >
        <MatrixVerificationPanel adapterId="bob" available />
      </NextIntlClientProvider>
    )
  },
  async unlock(accountId: string, rawKey: number[]) {
    getDb().close()
    lockAccountContentCipher()
    activateAccountDatabase(accountId)
    activateAccountContentCipher(
      await AccountContentCipher.fromRawKey(
        accountId,
        encryptedAccountDatabaseName(accountId),
        new Uint8Array(rawKey)
      )
    )
    await getDb().open()
    return getDb().name
  },
  async seedAdapter(id: string, homeserver: string) {
    if (!(await getAdapterInstance(id)))
      await createAdapterInstance(
        {
          type: "matrix",
          displayName: "Browser Matrix",
          enabled: true,
          transportMode: "longpoll",
          settings: { homeserver, preserve: "browser-value" },
          credentialsRef: { keyringService: "fixture", accounts: [] },
          trigger: {
            rules: [{ kind: "private-default" }],
            blockers: [],
            storeUnmatchedInDraftMode: false,
          },
          defaultMode: "auto",
        },
        { id }
      )
  },
  patchCursor: (id: string, cursor: string) =>
    patchAdapterInstanceSettings(id, { syncSinceToken: cursor }),
  persist: (adapterId: string, roomId: string, event: MatrixTimelineEvent) =>
    persistMatrixPendingEncryptedEvent({ adapterId, roomId, event }),
  failed: (id: string) => markMatrixPendingEventFailed(id, "fixture-admission-failure"),
  read: async (id: string) => ({
    name: getDb().name,
    row: await getAdapterInstance(id),
    pending: await getDb().matrixPendingEncryptedEvents.where("adapterId").equals(id).toArray(),
    retryable: await listRetryableMatrixPendingEvents(id, Number.MAX_SAFE_INTEGER),
  }),
  rawPending: () => rawRows(getDb().name, "matrixPendingEncryptedEvents"),
  rawAdapters: () => rawRows(getDb().name, "adapterInstances"),
  vault: {
    async create(accountId: string, password: string, activate = true) {
      if (await browserVaultExists(accountId)) throw new Error("Fixture Vault already exists")
      if (activate) await closeVault()
      const recovery = await provisionBrowserVault(accountId, password, activate)
      if (activate) await openVaultDatabase(accountId)
      return recovery
    },
    selectLocked: (accountId: string) => activateAccountDatabase(accountId),
    async unlock(accountId: string, password: string) {
      await closeVault()
      await unlockBrowserVault(accountId, password)
      return openVaultDatabase(accountId)
    },
    lock: closeVault,
    status: () => ({
      unlocked: getActiveBrowserVault()?.isUnlocked() ?? false,
      accountId: getActiveBrowserVault()?.localAccountId,
    }),
    storeCredential: (value: string) => activeVault().storeSecret(credentialName, value),
    loadCredential: () => activeVault().loadSecret(credentialName),
    async rotate(accountId: string, oldPassword: string, newPassword: string) {
      await changeBrowserVaultPassword(accountId, oldPassword, newPassword)
      await openVaultDatabase(accountId)
    },
    async recover(accountId: string, recovery: string, password: string) {
      await closeVault()
      await resetBrowserVaultPasswordWithRecoveryKey(accountId, recovery, password)
      await openVaultDatabase(accountId)
    },
    holdCredentialDecrypt() {
      if (credentialDecryptGate) throw new Error("Fixture credential decrypt is already held")
      const subtle = crypto.subtle
      const descriptor = Object.getOwnPropertyDescriptor(subtle, "decrypt")
      const original = subtle.decrypt.bind(subtle)
      let reached!: () => void
      let release!: () => void
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      Object.defineProperty(subtle, "decrypt", {
        configurable: true,
        value: async (algorithm: AesGcmParams, key: CryptoKey, bytes: BufferSource) => {
          const plaintext = await original(algorithm, key, bytes)
          const aad = algorithm.additionalData
            ? new TextDecoder().decode(algorithm.additionalData)
            : ""
          if (aad.includes(credentialName)) {
            reached()
            await held
          }
          return plaintext
        },
      })
      credentialDecryptGate = {
        reached: reachedPromise,
        release,
        restore: () => {
          if (descriptor) Object.defineProperty(subtle, "decrypt", descriptor)
          else Reflect.deleteProperty(subtle, "decrypt")
        },
      }
    },
    awaitCredentialDecrypt: async () => {
      if (!credentialDecryptGate) throw new Error("Fixture gate not armed")
      await credentialDecryptGate.reached
    },
    releaseCredentialDecrypt: () => {
      credentialDecryptGate?.release()
      credentialDecryptGate?.restore()
      credentialDecryptGate = undefined
    },
    async corruptPasswordWrap(accountId: string) {
      const repository = new BrowserVaultRepository()
      try {
        const record = await repository.get(accountId)
        if (!record) throw new Error("Fixture Vault missing")
        const bytes = decodeBase64Url(record.passwordWrap.ciphertext)
        bytes[0] ^= 1
        await repository.put({
          ...record,
          passwordWrap: { ...record.passwordWrap, ciphertext: encodeBase64Url(bytes) },
        })
      } finally {
        repository.close()
      }
    },
    raw: async () => ({
      vaults: await rawRows(BROWSER_VAULT_DB_NAME, "vaults"),
      secrets: await rawRows(BROWSER_VAULT_DB_NAME, "secrets"),
    }),
  },
  async start(homeserver: string, userId: string, deviceId: string, vaultCredential = false) {
    adapter = createMatrixAdapter({
      id: "bob",
      displayName: "Browser Matrix",
      homeserver,
      selfId: userId,
      deviceId,
      accessToken: async () => {
        if (!vaultCredential) return "fixture-bob"
        const vault = activeVault()
        const token = await vault.loadSecret(credentialName)
        if (getActiveBrowserVault() !== vault || !vault.isUnlocked())
          throw new Error("Matrix fixture Vault owner changed")
        if (!token) throw new Error("Matrix fixture credential unavailable")
        return token
      },
    })
    await adapter.start({
      adapterId: "bob",
      signal: new AbortController().signal,
      emit: async (event) => {
        if (rejectAdmission) {
          admissionRejections++
          throw new Error("fixture-admission-rejected")
        }
        events.push(event)
      },
      tauri: {
        httpRequest: connectorsHttpRequest,
        openWs: unsupported,
        fetchAttachment: unsupported,
        bindWebhookRoute: unsupported,
        unbindWebhookRoute: unsupported,
        publicBaseUrl: unsupported,
      },
      secrets: { get: unsupported, set: unsupported, delete: unsupported, list: unsupported },
      logger: {
        debug() {},
        info() {},
        warn: (...args) => {
          logs.push(args)
        },
        error: (...args) => {
          logs.push(args)
        },
      },
    })
  },
  stop: async () => {
    await adapter?.stop()
    adapter = undefined
  },
  bootstrap: () => {
    if (!adapter?.crossSigning) throw new Error("Matrix fixture adapter not started")
    return adapter.crossSigning.bootstrap()
  },
  reject: (value: boolean) => {
    rejectAdmission = value
  },
  diagnostics: () => ({ health: adapter?.health(), logs, admissionRejections }),
  events: () => events.map((event) => ({ id: event.messageId, text: event.plainText })),
}
window.matrixFixture = fixture
