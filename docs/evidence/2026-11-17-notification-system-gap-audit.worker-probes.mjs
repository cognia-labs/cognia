import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const root = process.cwd()
const ts = createRequire(path.join(root, "package.json"))("typescript")
let releasePrefs
const entered = []
const mocks = {
  "../policy/context": { notificationPolicyContext: () => ({}) },
  "./reconciler": {
    reconcileNotifications: async () => {
      entered.push("reconcile-after-stop")
      return { errors: 0 }
    },
  },
  "./webhook-sender": {
    sendPendingWebhookIntents: async () => {
      entered.push("webhook-after-stop")
      return { failed: 0 }
    },
  },
  "./feishu-webhook": { splitSecretRef: () => null },
  "@/lib/connectors/tauri/commands": {},
}
const moduleRecord = { exports: {} }
const source = ts.transpileModule(
  fs.readFileSync(path.join(root, "lib/notifications/delivery/worker.ts"), "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }
).outputText
new Function("require", "module", "exports", source)(
  (name) => {
    if (!(name in mocks)) throw new Error(`Unmocked audit dependency: ${name}`)
    return mocks[name]
  },
  moduleRecord,
  moduleRecord.exports
)

const stop = moduleRecord.exports.startNotificationDeliveryWorker({
  scopeKey: "scope-A",
  leaseOwner: "owner-A",
  emitCenter: async () => undefined,
  loadPrefs: () =>
    new Promise((resolve) => {
      releasePrefs = resolve
    }),
})
stop()
releasePrefs({})
for (let i = 0; entered.length < 2 && i < 10; i++) await new Promise(setImmediate)
assert.deepEqual(entered, ["reconcile-after-stop", "webhook-after-stop"])
console.log(
  JSON.stringify({
    scope: "Real worker with injected child-lane seams, no DB/network",
    afterStop: entered,
  })
)
