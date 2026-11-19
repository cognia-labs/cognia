// Read-only audit: execute the real collaboration notification module with
// isolated I/O, delaying a pull across disposal and an account change.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const ts = createRequire(path.join(root, "package.json"))("typescript")
const file = path.join(root, "lib/collab/notifications-sync.ts")
const mocks = {
  "@/lib/execution/personal-sink": {},
  "@cognia/logging": { loggers: { shell: { info() {}, warn() {} } } },
  "@/lib/notifications/read-state": { cascadeReadState: () => ({}) },
  "@/lib/chat/message-permalink": { buildSessionHref: () => "" },
  "@/lib/db/collab-chat-mirror": { sharedChatCacheKey: () => "" },
  "@/lib/issues/hrefs": { issueHref: () => "/issues" },
  "@/stores/notifications/notification-store": {},
  "./feed": {},
  "./refresh": {},
  "./targeted-invite-link": { targetedInviteHref: () => "/issues" },
}
const moduleRecord = { exports: {} }
const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
new Function("require", "module", "exports", source)(
  (name) => {
    if (!(name in mocks)) throw new Error(`Unmocked audit dependency: ${name}`)
    return mocks[name]
  },
  moduleRecord,
  moduleRecord.exports
)

async function main() {
  let release
  let entered = false
  let activeAccount = "account-A"
  const writes = []
  const rows = new Map()
  const local = {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: (key) => rows.delete(key),
  }
  const client = {
    baseUrl: "https://audit.invalid",
    identity: async () => ({ userId: "user-A" }),
    markNotificationsRead: async () => ({ marked: 0 }),
    listNotifications: async () => {
      entered = true
      await new Promise((resolve) => {
        release = resolve
      })
      return {
        notifications: [
          {
            id: "n-A",
            seq: 1,
            readAt: null,
            kind: "issue.assigned",
            subject: { entity: "issue", id: "issue-A" },
          },
        ],
        reads: [],
        nextAfterSeq: 1,
        hasMore: false,
        readCursor: { at: 0, seq: 0 },
        readsHaveMore: false,
      }
    },
  }
  const deps = {
    local,
    resolve: async () => ({ client, orgId: "org-A" }),
    describe: async () => ({ title: "A private issue", body: "" }),
    findLocal: async () => undefined,
    markLocalRead: async () => {},
    notify: async (input) => {
      writes.push({ activeAccount, title: input.title })
      return "n"
    },
    subscribeSignals: () => () => {},
    installReadPropagation: () => () => {},
  }
  const stop = moduleRecord.exports.installCollabNotificationsSync("account-A", deps)
  for (let i = 0; !entered && i < 20; i++) await new Promise(setImmediate)
  assert.equal(entered, true)
  stop()
  activeAccount = "account-B"
  release()
  for (let i = 0; writes.length === 0 && i < 20; i++) await new Promise(setImmediate)
  assert.deepEqual(writes[0], { activeAccount: "account-B", title: "A private issue" })
  console.log(
    JSON.stringify(
      {
        scope: "real sync lifecycle with injected notification sink; no real account DB or network",
        reproduced: "disposed account-A pull still hands content to the current account-B sink",
        writes,
      },
      null,
      2
    )
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
