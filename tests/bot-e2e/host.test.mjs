import test from "node:test"
import assert from "node:assert/strict"
import { BotHost, until, remains } from "./host.mjs"
import fs from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

test("failed spawn cleanup never signals an absent PID and still closes resources", async () => {
  const host = new BotHost()
  host.current = { child: { pid: undefined }, exited: true, done: Promise.resolve() }
  await host.close()
})

test("semantic polling reports the last observed state instead of passing silence", async () => {
  await assert.rejects(
    until(
      async () => ({ status: "pending" }),
      (value) => value.status === "completed",
      "delivery",
      1
    ),
    /delivery did not settle.*pending/
  )
})

test("evidence removes synthetic secrets from process logs", () => {
  const host = new BotHost()
  host.token = "test-secret-token"
  host.env = { COGNIA_MASTER_KEY: "test-master-key" }
  host.processes = [{ child: { pid: 123 }, log: "test-secret-token test-master-key" }]
  const evidence = JSON.stringify(host.evidence())
  assert.ok(!evidence.includes("test-secret-token"))
  assert.ok(!evidence.includes("test-master-key"))
})

test("negative observation rejects a late side effect after an initially clean read", async () => {
  let reads = 0
  await assert.rejects(
    remains(
      async () => (++reads > 1 ? ["late"] : []),
      (rows) => rows.length === 0,
      "effects",
      200
    ),
    /effects changed.*late/
  )
  assert.equal(reads, 2)
})

test("negative observation propagates read failures rather than accepting silence", async () => {
  await assert.rejects(
    remains(
      async () => {
        throw new Error("database unavailable")
      },
      () => true,
      "effects",
      1
    ),
    /database unavailable/
  )
})

test("durable observations read the owned SQLite profile without mutating it", async () => {
  const root = await fs.mkdtemp(path.resolve(".cache/bot-observer-"))
  const host = new BotHost()
  host.env = { COGNIA_HOME: path.join(root, "unused-cli-home") }
  host.directory = root
  try {
    const dir = path.join(root, "native-brain/durability/account/sqlite")
    await fs.mkdir(dir, { recursive: true })
    const db = new DatabaseSync(path.join(dir, "store.sqlite"))
    db.exec("CREATE TABLE durability_rows(table_name TEXT, value TEXT)")
    db.prepare("INSERT INTO durability_rows VALUES (?, ?)").run(
      "integrationEvents",
      JSON.stringify({ id: "event", projectionState: "complete" })
    )
    db.close()
    assert.deepEqual(await host.storedRows("integrationEvents"), [
      { id: "event", projectionState: "complete" },
    ])
    assert.deepEqual(await host.storedRows("notPresent"), [])
  } finally {
    host.agent.destroy()
    await fs.rm(root, { recursive: true, force: true })
  }
})
