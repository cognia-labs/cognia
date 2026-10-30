import { createRoot } from "react-dom/client"
import { NextIntlClientProvider } from "next-intl"
import { ThemeProvider } from "next-themes"
import { AccountGate } from "@/components/account/account-gate"
import { AccountStoreInitializer } from "@/components/providers/initializers/account-store-initializer"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAccountStore } from "@/stores/account/account-store"
import accountMessages from "@/i18n/messages/en/account.json"
import loadingMessages from "@/i18n/messages/en/loading.json"
import commonMessages from "@/i18n/messages/en/common.json"
import { getDb } from "@/lib/db/schema"
import { getActiveBrowserVault, BROWSER_VAULT_DB_NAME } from "@/lib/runtime/browser-vault"
import { createAdapterInstance, getAdapterInstance } from "@/lib/db/adapter-instances"
import {
  persistMatrixPendingEncryptedEvent,
  listRetryableMatrixPendingEvents,
} from "@/lib/db/matrix-pending-events"

function Workspace() {
  const name = useAccountStore(
    (state) => state.accounts.find((a) => a.id === state.unlockedAccountId)?.displayName
  )
  return (
    <main aria-label="Unlocked test workspace">
      <h1>{name}</h1>
      <button onClick={() => void useAccountStore.getState().lock()}>Lock workspace</button>
    </main>
  )
}

async function rawRows(database: string, stores: string[]) {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(database)
    request.onupgradeneeded = () => {
      request.transaction?.abort()
      reject(new Error("Expected existing account database"))
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await Promise.all(
      stores.map(
        (store) =>
          new Promise<unknown[]>((resolve, reject) => {
            const request = connection.transaction(store).objectStore(store).getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
      )
    )
  } finally {
    connection.close()
  }
}

// Only the surrounding workspace is a fixture; the gate, initializer, account
// singleton, runtime-target selection, Vault and database boot are production.
const root = document.createElement("div")
document.body.append(root)
createRoot(root).render(
  <NextIntlClientProvider
    locale="en"
    messages={{ account: accountMessages, loading: loadingMessages, common: commonMessages }}
  >
    <ThemeProvider attribute="class">
      <TooltipProvider>
        <AccountStoreInitializer />
        <AccountGate>
          <Workspace />
        </AccountGate>
      </TooltipProvider>
    </ThemeProvider>
  </NextIntlClientProvider>
)
let retainedDatabase: ReturnType<typeof getDb> | null = null

Object.assign(window, {
  accountFixture: {
    createSecondary: (displayName: string, password: string) =>
      useAccountStore.getState().createAccount({ displayName, password, activate: false }),
    state: () => {
      const { loaded, locked, unlockedAccountId, activeAccountId, accounts } =
        useAccountStore.getState()
      return {
        loaded,
        locked,
        unlockedAccountId,
        activeAccountId,
        accounts,
        database: locked || !unlockedAccountId ? null : getDb().name,
        vaultUnlocked: getActiveBrowserVault()?.isUnlocked() ?? false,
      }
    },
    async persist(marker: string) {
      retainedDatabase = getDb()
      await createAdapterInstance(
        {
          type: "matrix",
          displayName: "Gate Matrix",
          enabled: false,
          transportMode: "longpoll",
          settings: {},
          credentialsRef: { keyringService: "fixture", accounts: [] },
          trigger: {
            rules: [{ kind: "private-default" }],
            blockers: [],
            storeUnmatchedInDraftMode: false,
          },
          defaultMode: "auto",
          mediaModelPolicy: "local_extract_only",
        },
        { id: "gate-matrix" }
      )
      await getActiveBrowserVault()!.storeSecret("matrix:gate-token", marker)
      return persistMatrixPendingEncryptedEvent({
        adapterId: "gate-matrix",
        roomId: "!gate:fixture.test",
        event: {
          event_id: "$gate",
          type: "m.room.encrypted",
          sender: "@peer:fixture.test",
          origin_server_ts: 1,
          content: { ciphertext: marker },
        },
      })
    },
    async read() {
      if (!getActiveBrowserVault()?.isUnlocked()) throw new Error("AccountGate Vault is locked")
      return {
        adapter: await getAdapterInstance("gate-matrix"),
        pending: await listRetryableMatrixPendingEvents("gate-matrix", Number.MAX_SAFE_INTEGER),
        token: await getActiveBrowserVault()!.loadSecret("matrix:gate-token"),
      }
    },
    // Captured production database handle: no Vault/status pre-check may make
    // this negative test pass. Real encrypted-content middleware must refuse.
    readRetainedContent: () =>
      retainedDatabase!.matrixPendingEncryptedEvents.get("gate-matrix\u0000$gate"),
    async raw(database: string) {
      return {
        account: await rawRows(database, ["matrixPendingEncryptedEvents", "adapterInstances"]),
        vault: await rawRows(BROWSER_VAULT_DB_NAME, ["vaults", "secrets"]),
      }
    },
  },
})
