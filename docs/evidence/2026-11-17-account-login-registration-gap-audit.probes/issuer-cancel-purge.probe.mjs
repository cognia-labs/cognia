import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { stripTypeScriptTypes } from "node:module"
import { DatabaseSync } from "node:sqlite"

// Read-only review probe. No service dependencies, account, or deployment.
// Loads the actual unmodified store.ts/purge.ts into memory. Uses real SQLite
// SQL via a minimal asynchronous D1 interface; only the service-binding purge
// hook and Better Auth's deleteUser integration are controlled external edges.
const service = resolve(process.argv[2] ?? "../cognia-services/services/identity-server")
const sources = ["src/deletion/store.ts", "src/deletion/purge.ts"]
const sourceText = Object.fromEntries(
  sources.map((path) => [path, readFileSync(`${service}/${path}`, "utf8")])
)
const sourceSha256 = Object.fromEntries(
  sources.map((path) => [path, createHash("sha256").update(sourceText[path]).digest("hex")])
)
const asDataUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
const storeUrl = asDataUrl(stripTypeScriptTypes(sourceText[sources[0]]))
const { requestDeletion, cancelDeletion, getDeletion } = await import(storeUrl)
const { purgeDueDeletions } = await import(
  asDataUrl(
    stripTypeScriptTypes(sourceText[sources[1]]).replace('"./store"', JSON.stringify(storeUrl))
  )
)

const sqlite = new DatabaseSync(":memory:")
sqlite.exec(readFileSync(`${service}/migrations/0003_account_deletion.sql`, "utf8"))
sqlite.exec(`
  CREATE TABLE "user" ("id" TEXT PRIMARY KEY);
  CREATE TABLE "oauthAccessToken" ("userId" TEXT);
  CREATE TABLE "oauthRefreshToken" ("userId" TEXT);
  CREATE TABLE "oauthConsent" ("userId" TEXT);
`)

// D1 prepare/bind/first/all/run and atomic batch semantics over SQLite. No SQL
// interpretation or rewritten production query: the owning modules supply it.
const d1 = {
  prepare(sql) {
    return {
      bind(...values) {
        const statement = sqlite.prepare(sql)
        return {
          async first() {
            return statement.get(...values) ?? null
          },
          async all() {
            return { results: statement.all(...values) }
          },
          async run() {
            const result = statement.run(...values)
            return { meta: { changes: Number(result.changes) } }
          },
        }
      },
    }
  },
  async batch(statements) {
    sqlite.exec("BEGIN")
    try {
      const result = []
      for (const statement of statements) result.push(await statement.run())
      sqlite.exec("COMMIT")
      return result
    } catch (error) {
      sqlite.exec("ROLLBACK")
      throw error
    }
  },
}

const userId = "usr_cancelrace"
for (const table of ["user", "oauthAccessToken", "oauthRefreshToken", "oauthConsent"]) {
  sqlite.prepare(`INSERT INTO "${table}" VALUES (?)`).run(userId)
}
await requestDeletion(d1, userId, new Date("2026-11-01T00:00:00.000Z"), 7)
let enterHook, releaseHook
const hookEntered = new Promise((resolve) => {
  enterHook = resolve
})
const hookReleased = new Promise((resolve) => {
  releaseHook = resolve
})
let deleteUserCalls = 0
const purging = purgeDueDeletions({
  db: d1,
  now: () => new Date("2026-11-17T00:00:00.000Z"),
  hooks: [
    async () => {
      // Production analogue: awaiting SYNC_ADMIN.purgeSpace(userId) from
      // purgeHooksFor(). No real sync data or binding is contacted here.
      enterHook()
      await hookReleased
    },
  ],
  deleteUser: async (id) => {
    deleteUserCalls++
    sqlite.prepare('DELETE FROM "user" WHERE "id" = ?').run(id)
  },
})

await hookEntered
// This is AFTER purgeAfter. The real store has no deadline guard, and the
// real routes.ts DELETE branch invokes it without a purgeAfter check.
const cancelResult = await cancelDeletion(d1, userId, new Date("2026-11-17T00:00:01.000Z"))
assert.equal(cancelResult.status, "cancelled")
releaseHook()
const purgeReport = await purging
const deletionRecord = await getDeletion(d1, userId)
const rows = Object.fromEntries(
  ["user", "oauthAccessToken", "oauthRefreshToken", "oauthConsent"].map((table) => [
    table,
    sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count,
  ])
)
assert.equal(deleteUserCalls, 1)
assert.equal(deletionRecord.status, "cancelled")
assert.deepEqual(rows, { user: 0, oauthAccessToken: 0, oauthRefreshToken: 0, oauthConsent: 0 })
assert.deepEqual(purgeReport, { purged: [userId], failed: [] })
console.log(
  JSON.stringify(
    {
      sourceSha256,
      cancellationReturned: cancelResult.status,
      deletionRecord,
      rows,
      deleteUserCalls,
      purgeReport,
    },
    null,
    2
  )
)

// Control: a cancellation completed before the cron snapshot must preserve the user.
const controlId = "usr_cancel_before_snapshot"
for (const table of ["user", "oauthAccessToken", "oauthRefreshToken", "oauthConsent"]) {
  sqlite.prepare(`INSERT INTO "${table}" VALUES (?)`).run(controlId)
}
await requestDeletion(d1, controlId, new Date("2026-11-01T00:00:00.000Z"), 7)
assert.equal(
  (await cancelDeletion(d1, controlId, new Date("2026-11-07T00:00:00.000Z"))).status,
  "cancelled"
)
const controlReport = await purgeDueDeletions({
  db: d1,
  now: () => new Date("2026-11-17T00:00:00.000Z"),
  deleteUser: async () => {
    assert.fail("cancelled-before-snapshot user must not be deleted")
  },
})
assert.deepEqual(controlReport, { purged: [], failed: [] })
assert.equal(
  sqlite.prepare('SELECT COUNT(*) AS count FROM "user" WHERE "id" = ?').get(controlId).count,
  1
)
console.log(JSON.stringify({ control: "cancel-before-snapshot-preserves-user", passed: true }))
sqlite.close()
