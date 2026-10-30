import { test, expect, chromium } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { directory, validate } from "./matrix-browser-setup.mjs"

let native
let bundle
let accountBundle
let accountCss
const accountChunks = new Map()
const account = "acct_matrix_disk"
const key = [...randomBytes(32)]
test.beforeAll(async () => {
  const manifest = await validate()
  native = await import(path.join(directory, "node.mjs"))
  bundle = await fs.readFile(path.join(directory, "browser.js"))
  if (manifest.accountUi) accountBundle = await fs.readFile(path.join(directory, "account.js"))
  accountCss = await fs.readFile(path.join(directory, "account.css"))
  for (const file of (await validate()).outputs)
    if (file.includes("/account-chunks/"))
      accountChunks.set("/" + path.relative(directory, file), await fs.readFile(file))
})

async function withFixture(info, run, { failListen = false, accountUi = false } = {}) {
  const profileRoot = path.resolve(".cache/test-results/matrix-browser/profiles")
  await fs.mkdir(profileRoot, { recursive: true })
  let profile
  let wire
  let server
  let context
  let stopped = false
  let browserClosing = true
  const polls = []
  try {
    profile = await fs.mkdtemp(path.join(profileRoot, "chromium-"))
    wire = new native.ConnectorLoopback(info.title)
    await wire.open()
    const relay = native.createMatrixRelay()
    const queued = []
    wire.onHttp = (request) => {
      const crypto = relay.respond(request)
      if (crypto) return crypto
      if (request.url.pathname.endsWith("/sync")) {
        if (stopped || browserClosing) return { status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } }
        if (queued.length) return queued.shift()
        const held = native.deferred()
        polls.push(held)
        return held.promise
      }
      if (request.url.pathname.endsWith("/joined_members"))
        return {
          body: {
            joined: { [native.identity("alice").userId]: {}, [native.identity("bob").userId]: {} },
          },
        }
      if (request.url.pathname.endsWith("/state/m.room.encryption"))
        return { body: { algorithm: "m.megolm.v1.aes-sha2" } }
      return { status: 404, body: {} }
    }
    server = createServer((request, response) => {
      response.writeHead(200, {
        "content-type":
          request.url === "/account.css"
            ? "text/css"
            : request.url === "/fixture.js" || accountChunks.has(request.url)
              ? "text/javascript"
              : "text/html",
      })
      response.end(
        (request.url === "/account.css" ? accountCss : accountChunks.get(request.url)) ??
          (request.url === "/fixture.js"
            ? accountUi
              ? accountBundle
              : bundle
            : `<!doctype html><title>Matrix persistence integration</title><link rel="stylesheet" href="/account.css"><script type="module" src="/fixture.js"></script>`)
      )
    })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(failListen ? -1 : 0, "127.0.0.1", resolve)
    })
    const origin = `http://127.0.0.1:${server.address().port}`
    const errors = []
    const launch = async ({ rawUnlock = true } = {}) => {
      browserClosing = false
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        serviceWorkers: "block",
      })
      await context.exposeBinding("matrixNative", (_source, name, args) =>
        wire.native.call(name, args)
      )
      const page = context.pages()[0]
      page.on("pageerror", (error) => {
        errors.push(error.message)
      })
      page.on("console", (message) => {
        if (accountUi && message.type() === "error") errors.push(message.text())
      })
      await page.goto(origin)
      await page
        .waitForFunction(
          (accountUi) => Boolean(accountUi ? window.accountFixture : window.matrixFixture),
          accountUi
        )
        .catch((error) => {
          throw new Error(`${error.message}; page errors: ${errors.join("; ")}`)
        })
      if (rawUnlock)
        await page.evaluate(({ account, key }) => window.matrixFixture.unlock(account, key), {
          account,
          key,
        })
      return page
    }
    const reply = (body) => {
      const response = { body }
      const held = polls.shift()
      if (held) held.resolve(response)
      else queued.push(response)
    }
    await run({
      wire,
      relay,
      reply,
      origin,
      launch,
      close: async (duringClose) => {
        browserClosing = true
        const closing = context.close()
        try {
          await duringClose?.()
        } finally {
          await closing
        }
        context = undefined
        // End abandoned native HTTP polls after this browser has disappeared.
        for (const poll of polls.splice(0))
          poll.resolve({ status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } })
        await expect.poll(() => wire.native.pendingCount).toBe(0)
      },
    })
    expect(errors).toEqual([])
    expect(wire.errors).toEqual([])
    await validate()
  } finally {
    stopped = true
    for (const poll of polls.splice(0))
      poll.resolve({ status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } })
    try {
      await context?.close()
    } finally {
      server?.closeAllConnections()
      if (server?.listening) await new Promise((resolve) => server.close(resolve))
      try {
        await wire?.close()
      } finally {
        if (profile) await fs.rm(profile, { recursive: true, force: true })
      }
    }
  }
}

const event = (id, marker) => ({
  type: "m.room.encrypted",
  event_id: id,
  sender: "@alice:fixture.test",
  origin_server_ts: 1,
  content: {
    algorithm: "m.megolm.v1.aes-sha2",
    ciphertext: marker,
    session_id: "pending-session",
    sender_key: "sender",
  },
  unsigned: { fixtureMarker: marker },
})

async function createThroughGate(page, name = "Matrix UI account") {
  const form = page.getByRole("form", { name: "Create local account" })
  await expect(form).toBeVisible()
  await form.getByLabel("Account name").fill(name)
  await form.getByLabel("Password", { exact: true }).fill("correct horse matrix battery")
  await form.getByRole("button", { name: "Create account" }).click()
  const recovery = page.getByRole("region", { name: "Save recovery key" })
  await expect(recovery).toBeVisible()
  const key = await recovery.locator("code").innerText()
  await expect(recovery.getByRole("button", { name: "Continue" })).toBeDisabled()
  await expect(page.getByRole("main", { name: "Unlocked test workspace" })).toHaveCount(0)
  await recovery.getByRole("checkbox", { name: "I saved this recovery key" }).check()
  await recovery.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByRole("main", { name: "Unlocked test workspace" })).toBeVisible()
  return key
}

test("AccountGate UI creates, locks and reopens actual encrypted Matrix content after browser restart", async ({}, info) => {
  await withFixture(
    info,
    async (f) => {
      let page = await f.launch({ rawUnlock: false })
      await createThroughGate(page)
      await page.evaluate(() => window.accountFixture.persist("private-gate-matrix-token"))
      const before = await page.evaluate(() => window.accountFixture.read())
      expect(before.pending).toHaveLength(1)
      expect(before.pending[0]).toMatchObject({
        adapterId: "gate-matrix",
        eventId: "$gate",
        rawEvent: { content: { ciphertext: "private-gate-matrix-token" } },
      })
      expect(before.token).toBe("private-gate-matrix-token")
      expect(before.adapter).toMatchObject({ id: "gate-matrix", type: "matrix" })
      const database = (await page.evaluate(() => window.accountFixture.state())).database
      const rawBefore = await page.evaluate((name) => window.accountFixture.raw(name), database)
      expect(JSON.stringify(rawBefore)).not.toContain("private-gate-matrix-token")

      await page.getByRole("button", { name: "Lock workspace" }).click()
      const form = page.getByRole("region", { name: "Unlock local account" })
      await expect(form).toBeVisible()
      await form.getByLabel("Password", { exact: true }).fill("incorrect account password")
      await form.getByRole("button", { name: "Unlock", exact: true }).click()
      await expect(page.getByRole("alert")).toContainText("That password is not correct.")
      expect(await page.evaluate(() => window.accountFixture.state())).toMatchObject({
        locked: true,
        vaultUnlocked: false,
      })
      await expect(page.evaluate(() => window.accountFixture.read())).rejects.toThrow(
        "Vault is locked"
      )
      await expect(
        page.evaluate(() => window.accountFixture.readRetainedContent())
      ).rejects.toThrow()
      expect(await page.evaluate((name) => window.accountFixture.raw(name), database)).toEqual(
        rawBefore
      )

      await expect(page.getByRole("main", { name: "Unlocked test workspace" })).toHaveCount(0)
      await form.getByLabel("Password", { exact: true }).fill("correct horse matrix battery")
      await form.getByRole("button", { name: "Unlock", exact: true }).click()
      await expect(page.getByRole("main", { name: "Unlocked test workspace" })).toBeVisible()
      expect(await page.evaluate(() => window.accountFixture.read())).toEqual(before)
      await f.close()
      page = await f.launch({ rawUnlock: false })
      await expect(page.getByRole("region", { name: "Unlock local account" })).toBeVisible()
      await expect(page.getByRole("main", { name: "Unlocked test workspace" })).toHaveCount(0)
      await page.getByLabel("Password", { exact: true }).fill("correct horse matrix battery")
      await page.getByRole("button", { name: "Unlock", exact: true }).click()
      await expect(page.getByRole("main", { name: "Unlocked test workspace" })).toBeVisible()
      expect(await page.evaluate(() => window.accountFixture.read())).toEqual(before)
      await page.screenshot({ path: info.outputPath("account-gate-unlocked.png") })
    },
    { accountUi: true }
  )
})

test("AccountGate recovery form rejects wrong keys and rotates the password while preserving Matrix data", async ({}, info) => {
  await withFixture(
    info,
    async (f) => {
      const page = await f.launch({ rawUnlock: false })
      const key = await createThroughGate(page)
      await page.evaluate(() => window.accountFixture.persist("private-gate-recovery-token"))
      const before = await page.evaluate(() => window.accountFixture.read())
      expect(before.pending).toHaveLength(1)
      expect(before.pending[0]).toMatchObject({
        adapterId: "gate-matrix",
        eventId: "$gate",
        rawEvent: { content: { ciphertext: "private-gate-recovery-token" } },
      })
      expect(before.token).toBe("private-gate-recovery-token")
      expect(before.adapter).toMatchObject({ id: "gate-matrix", type: "matrix" })
      const database = (await page.evaluate(() => window.accountFixture.state())).database
      const rawBefore = await page.evaluate((name) => window.accountFixture.raw(name), database)
      expect(JSON.stringify(rawBefore)).not.toContain("private-gate-recovery-token")

      await page.getByRole("button", { name: "Lock workspace" }).click()
      await page.getByRole("button", { name: "Forgot your password?" }).click()
      const form = page.getByRole("region", { name: "Unlock with a recovery key" })
      await form.getByLabel("Recovery key", { exact: true }).fill("wrong-recovery-key")
      await form.getByLabel("New password", { exact: true }).fill("new matrix account password")
      await form
        .getByLabel("Confirm new password", { exact: true })
        .fill("new matrix account password")
      await form.getByRole("button", { name: "Unlock and set a new password" }).click()
      await expect(page.getByRole("alert")).toContainText("That recovery key is not correct.")
      expect(await page.evaluate(() => window.accountFixture.state())).toMatchObject({
        locked: true,
        vaultUnlocked: false,
      })
      await expect(page.evaluate(() => window.accountFixture.read())).rejects.toThrow(
        "Vault is locked"
      )
      await expect(
        page.evaluate(() => window.accountFixture.readRetainedContent())
      ).rejects.toThrow()
      expect(await page.evaluate((name) => window.accountFixture.raw(name), database)).toEqual(
        rawBefore
      )
      await form.getByLabel("Recovery key", { exact: true }).fill(key)
      await form.getByRole("button", { name: "Unlock and set a new password" }).click()
      await expect(page.getByRole("main", { name: "Unlocked test workspace" })).toBeVisible()
      expect(await page.evaluate(() => window.accountFixture.read())).toEqual(before)
      await page.getByRole("button", { name: "Lock workspace" }).click()
      const unlock = page.getByRole("region", { name: "Unlock local account" })
      await unlock.getByLabel("Password", { exact: true }).fill("correct horse matrix battery")
      await unlock.getByRole("button", { name: "Unlock", exact: true }).click()
      await expect(page.getByRole("alert")).toContainText("That password is not correct.")
      await unlock.getByLabel("Password", { exact: true }).fill("new matrix account password")
      await unlock.getByRole("button", { name: "Unlock", exact: true }).click()
      await expect(page.getByRole("main", { name: "Unlocked test workspace" })).toBeVisible()
      expect(await page.evaluate(() => window.accountFixture.read())).toEqual(before)
    },
    { accountUi: true }
  )
})

test("AccountGate switches actual account databases and requires acknowledgement for each recovery key", async ({}, info) => {
  await withFixture(
    info,
    async (f) => {
      const page = await f.launch({ rawUnlock: false })
      await createThroughGate(page, "First Matrix account")
      await page.evaluate(() => window.accountFixture.persist("first-account-private-token"))
      const first = await page.evaluate(() => window.accountFixture.read())
      expect(first.pending).toHaveLength(1)
      expect(first.token).toBe("first-account-private-token")
      await page.evaluate(() =>
        window.accountFixture.createSecondary("Second Matrix account", "second account password")
      )
      const recovery = page.getByRole("region", { name: "Save recovery key" })
      await expect(recovery.getByRole("button", { name: "Continue" })).toBeDisabled()
      await recovery.getByRole("checkbox", { name: "I saved this recovery key" }).check()
      await recovery.getByRole("button", { name: "Continue" }).click()
      await page.getByRole("button", { name: "Lock workspace" }).click()
      await page.getByRole("button", { name: "First Matrix account, switch account" }).click()
      await page.getByRole("menuitemradio", { name: "Second Matrix account" }).click()
      await page.getByLabel("Password", { exact: true }).fill("second account password")
      await page.getByRole("button", { name: "Unlock", exact: true }).click()
      await expect(
        page.getByRole("heading", { name: "Second Matrix account", exact: true })
      ).toBeVisible()
      expect(await page.evaluate(() => window.accountFixture.read())).toEqual({
        adapter: undefined,
        pending: [],
        token: null,
      })
      await page.evaluate(() => window.accountFixture.persist("second-account-private-token"))
      expect((await page.evaluate(() => window.accountFixture.read())).token).toBe(
        "second-account-private-token"
      )
      await page.getByRole("button", { name: "Lock workspace" }).click()
      await page.getByRole("button", { name: "Second Matrix account, switch account" }).click()
      await page.getByRole("menuitemradio", { name: "First Matrix account" }).click()
      await page.getByLabel("Password", { exact: true }).fill("correct horse matrix battery")
      await page.getByRole("button", { name: "Unlock", exact: true }).click()
      await expect(
        page.getByRole("heading", { name: "First Matrix account", exact: true })
      ).toBeVisible()
      expect(await page.evaluate(() => window.accountFixture.read())).toEqual(first)
    },
    { accountUi: true }
  )
})

test("disk IndexedDB preserves encrypted pending data, retry state and cursor across a new browser process", async ({}, info) => {
  await withFixture(info, async (f) => {
    let page = await f.launch()
    const pending = event("$disk-event", "private-disk-marker")
    await page.evaluate(
      async ({ origin, pending }) => {
        await window.matrixFixture.seedAdapter("bob", origin)
        await window.matrixFixture.patchCursor("bob", "disk-cursor-42")
        const stored = await window.matrixFixture.persist("bob", "!private:fixture.test", pending)
        await window.matrixFixture.failed(stored.row.id)
      },
      { origin: f.wire.origin, pending }
    )
    const before = await page.evaluate(() => window.matrixFixture.read("bob"))
    expect(before.pending).toHaveLength(1)
    expect(before.pending[0]).toMatchObject({ attempts: 1, state: "pending", rawEvent: pending })
    const raw = await page.evaluate(() => window.matrixFixture.rawPending())
    expect(raw).toHaveLength(1)
    expect(raw[0].__cogniaEncryptedContent).toMatchObject({
      algorithm: "AES-256-GCM",
      accountId: account,
    })
    expect(JSON.stringify(raw)).not.toContain("private-disk-marker")
    await f.close()
    page = await f.launch()
    const after = await page.evaluate(() => window.matrixFixture.read("bob"))
    expect(after).toEqual(before)
    expect(after.row.settings).toMatchObject({
      syncSinceToken: "disk-cursor-42",
      preserve: "browser-value",
    })
    expect(
      await page.evaluate(
        (pending) => window.matrixFixture.persist("bob", "!private:fixture.test", pending),
        pending
      )
    ).toMatchObject({
      ok: true,
      deduplicated: true,
      row: { attempts: 1, firstSeenAt: before.pending[0].firstSeenAt },
    })
  })
})

test("real concurrent tabs deduplicate atomically and account keys isolate the same adapter/event IDs", async ({}, info) => {
  await withFixture(info, async (f) => {
    const page = await f.launch()
    const second = await page.context().newPage()
    await second.goto(f.origin)
    await second.waitForFunction(() => Boolean(window.matrixFixture))
    await second.evaluate(({ account, key }) => window.matrixFixture.unlock(account, key), {
      account,
      key,
    })
    const pending = event("$concurrent", "account-a-private")
    const insert = (target) =>
      target.evaluate(
        (pending) => window.matrixFixture.persist("bob", "!private:fixture.test", pending),
        pending
      )
    const inserts = await Promise.all([insert(page), insert(second)])
    expect(inserts.map((row) => row.deduplicated).sort()).toEqual([false, true])
    expect((await page.evaluate(() => window.matrixFixture.read("bob"))).pending).toHaveLength(1)
    await second.close()
    await page.evaluate(async () => {
      await window.matrixFixture.unlock("acct_matrix_other", Array(32).fill(9))
    })
    expect((await page.evaluate(() => window.matrixFixture.read("bob"))).pending).toHaveLength(0)
    await page.evaluate(
      (pending) => window.matrixFixture.persist("bob", "!private:fixture.test", pending),
      event("$concurrent", "account-b-private")
    )
    await page.evaluate(({ account, key }) => window.matrixFixture.unlock(account, key), {
      account,
      key,
    })
    expect(
      (await page.evaluate(() => window.matrixFixture.read("bob"))).pending[0].rawEvent
    ).toEqual(pending)
    await page.evaluate(
      (account) => window.matrixFixture.unlock(account, Array(32).fill(7)),
      account
    )
    await expect(page.evaluate(() => window.matrixFixture.read("bob"))).rejects.toThrow()
    await page.evaluate(({ account, key }) => window.matrixFixture.unlock(account, key), {
      account,
      key,
    })
    expect(
      (await page.evaluate(() => window.matrixFixture.read("bob"))).pending[0].rawEvent
    ).toEqual(pending)
  })
})

async function dispatch(wire, adapterId, requests) {
  for (const request of requests) {
    const response = await native.connectorsHttpRequest({
      url: wire.origin + request.path,
      method: request.method,
      headers: { authorization: `Bearer fixture-${adapterId}`, "content-type": "application/json" },
      body: JSON.stringify(request.body),
    })
    expect(response.status).toBe(200)
    await native.connectorsMatrixCryptoMarkRequestSent({
      adapterId,
      requestId: request.requestId,
      kind: request.kind,
      response: JSON.parse(response.body),
    })
  }
}

// Protocol relay is a local homeserver; UI and crypto remain production owners.
async function verificationUi(f, run) {
  const page = await f.launch()
  await page.evaluate(
    async ({ origin, identity }) => {
      await window.matrixFixture.seedAdapter("bob", origin)
      await window.matrixFixture.start(origin, identity.userId, identity.deviceId)
      window.matrixFixture.mountVerification()
    },
    { origin: f.wire.origin, identity: native.identity("bob") }
  )
  await native.connectorsMatrixCryptoInit(native.identity("alice"))
  for (const id of ["alice", "bob"]) {
    await dispatch(f.wire, id, await native.connectorsMatrixCryptoOutgoingRequests(id))
    const prepared = await native.connectorsMatrixCryptoCrossSigning({
      adapterId: id,
      action: "prepare",
      serverMasterKey: null,
    })
    await dispatch(f.wire, id, prepared.requests)
  }
  for (const id of ["alice", "bob"]) {
    await native.connectorsMatrixCryptoUpdateTrackedUsers({
      adapterId: id,
      userIds: [native.identity(id === "alice" ? "bob" : "alice").userId],
    })
    await native.connectorsMatrixCryptoReceiveSyncChanges({
      adapterId: id,
      changedDevices: [native.identity("alice").userId, native.identity("bob").userId],
    })
    await dispatch(f.wire, id, await native.connectorsMatrixCryptoOutgoingRequests(id))
  }
  let batch = 0
  const pump = async () => {
    for (let round = 0; round < 8; round++) {
      const alice = f.relay.inbox.get(native.identity("alice").userId) ?? []
      f.relay.inbox.delete(native.identity("alice").userId)
      if (alice.length)
        await native.connectorsMatrixCryptoReceiveSyncChanges({
          adapterId: "alice",
          toDeviceEvents: alice,
        })
      const bob = f.relay.inbox.get(native.identity("bob").userId) ?? []
      f.relay.inbox.delete(native.identity("bob").userId)
      if (bob.length)
        f.reply({
          next_batch: `verification-${++batch}`,
          to_device: { events: bob },
          rooms: { join: {} },
        })
      await dispatch(f.wire, "alice", await native.connectorsMatrixCryptoOutgoingRequests("alice"))
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  const peer = async (action, flowId, extra = {}) => {
    const result = await native.connectorsMatrixCryptoVerification({
      adapterId: "alice",
      userId: native.identity("bob").userId,
      action,
      flowId,
      ...extra,
    })
    await dispatch(f.wire, "alice", result.requests)
    await pump()
    if (result.state === "done") {
      await native.connectorsMatrixCryptoReceiveSyncChanges({
        adapterId: "alice",
        changedDevices: [native.identity("alice").userId, native.identity("bob").userId],
      })
      await dispatch(f.wire, "alice", await native.connectorsMatrixCryptoOutgoingRequests("alice"))
      return native.connectorsMatrixCryptoVerification({
        adapterId: "alice",
        userId: native.identity("bob").userId,
        action: "status",
        flowId,
      })
    }
    return result
  }
  await page.getByLabel("Peer Matrix user").fill(native.identity("alice").userId)
  await page.getByLabel("Peer device ID").fill(native.identity("alice").deviceId)
  await page.getByRole("button", { name: "Request verification", exact: true }).click()
  const incoming = await expect
    .poll(async () => {
      await pump()
      return (
        await native.connectorsMatrixCryptoVerification({
          adapterId: "alice",
          userId: native.identity("bob").userId,
          action: "list",
        })
      ).flows.length
    })
    .toBe(1)
  void incoming
  const {
    flows: [flow],
  } = await native.connectorsMatrixCryptoVerification({
    adapterId: "alice",
    userId: native.identity("bob").userId,
    action: "list",
  })
  await peer("accept", flow.flowId)
  await expect(page.getByRole("button", { name: "Compare numbers", exact: true })).toBeVisible()
  await run({ page, peer, pump, flowId: flow.flowId })
  await page.evaluate(() => window.matrixFixture.stop())
}

for (const refuse of [false, true])
  test(`Matrix operator UI SAS ${refuse ? "refusal" : "mutual confirmation"} uses real native peers`, async ({}, info) => {
    await withFixture(info, async (f) =>
      verificationUi(f, async ({ page, peer, pump, flowId }) => {
        await page.getByRole("button", { name: "Compare numbers", exact: true }).click()
        await pump()
        await peer("acceptSas", flowId)
        const alice = await peer("status", flowId)
        await expect(page.getByLabel("Verification numbers")).toHaveText(alice.decimals.join(" · "))
        expect(alice.deviceVerified).toBe(false)
        if (!refuse) await peer("confirmSas", flowId)
        await page
          .getByRole("button", {
            name: refuse ? "The numbers do not match" : "The numbers match",
            exact: true,
          })
          .click()
        await pump()
        await expect(page.getByRole("status")).toHaveText(
          refuse ? "Verification cancelled" : "Verification complete"
        )
        expect(await peer("status", flowId)).toMatchObject({
          state: refuse ? "cancelled" : "done",
          deviceVerified: !refuse,
        })
        await page.screenshot({ path: info.outputPath("matrix-sas.png") })
      })
    )
  })

test("Matrix operator QR upload decodes actual binary keys and waits for explicit peer confirmation", async ({}, info) => {
  await withFixture(info, async (f) =>
    verificationUi(f, async ({ page, peer, pump, flowId }) => {
      await page.getByLabel("Scan a QR image").setInputFiles({
        name: "invalid.png",
        mimeType: "image/png",
        buffer: Buffer.from("invalid image bytes"),
      })
      await expect(page.getByRole("alert")).toContainText(
        "Choose a valid Matrix verification QR image"
      )
      expect(
        f.wire.commands.filter(
          (call) =>
            call.name === "connectors_matrix_crypto_verification" &&
            call.args?.req?.action === "scanQr"
        )
      ).toHaveLength(0)
      expect(await peer("status", flowId)).toMatchObject({ state: "ready", deviceVerified: false })
      const qr = await peer("generateQr", flowId)
      const png = await page.evaluate(({ size, modules }) => {
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = (size + 8) * 5
        const context = canvas.getContext("2d")
        context.fillStyle = "white"
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.fillStyle = "black"
        modules.forEach((dark, i) => {
          if (dark) context.fillRect(((i % size) + 4) * 5, (Math.floor(i / size) + 4) * 5, 5, 5)
        })
        return canvas.toDataURL("image/png").split(",")[1]
      }, qr.qrImage)
      await page.getByLabel("Scan a QR image").setInputFiles({
        name: "matrix.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      })
      await expect.poll(async () => (await peer("status", flowId)).scanned).toBe(true)
      expect(await peer("status", flowId)).toMatchObject({
        state: "qr",
        deviceVerified: false,
        confirmed: false,
      })
      await peer("confirmQr", flowId)
      await pump()
      await expect(page.getByRole("status")).toHaveText("Verification complete")
      const refresh = page.getByRole("button", { name: "Refresh device trust", exact: true })
      if (await refresh.isVisible()) await refresh.click()
      await expect(page.getByText("Device verified.", { exact: true })).toBeVisible()
      expect(await peer("status", flowId)).toMatchObject({ state: "done", deviceVerified: true })
    })
  )
})

test("Matrix operator QR display is optically readable by the real peer", async ({}, info) => {
  await withFixture(info, async (f) =>
    verificationUi(f, async ({ page, peer, pump, flowId }) => {
      await page.getByRole("button", { name: "Show QR code", exact: true }).click()
      const qr = page.getByRole("img", { name: "Matrix verification QR code" })
      await expect(qr).toBeVisible()
      const bytes = await qr.evaluate(
        (svg) =>
          new Promise((resolve, reject) => {
            const image = new Image()
            image.onload = () => {
              const canvas = document.createElement("canvas")
              canvas.width = canvas.height = 512
              const context = canvas.getContext("2d")
              context.drawImage(image, 0, 0, 512, 512)
              try {
                resolve(
                  window.matrixFixture.decodePixels(
                    context.getImageData(0, 0, 512, 512).data,
                    512,
                    512
                  )
                )
              } catch (error) {
                reject(error)
              }
            }
            image.onerror = reject
            image.src =
              "data:image/svg+xml;base64," + btoa(new XMLSerializer().serializeToString(svg))
          })
      )
      await peer("scanQr", flowId, { qrBytes: bytes })
      await expect(
        page.getByRole("button", {
          name: "Confirm the other device scanned this code",
          exact: true,
        })
      ).toBeVisible()
      expect(await peer("status", flowId)).toMatchObject({ deviceVerified: false })
      await page
        .getByRole("button", { name: "Confirm the other device scanned this code", exact: true })
        .click()
      await pump()
      await expect(page.getByRole("status")).toHaveText("Verification complete")
      await expect(qr).toHaveCount(0)
      const refresh = page.getByRole("button", { name: "Refresh device trust", exact: true })
      if (await refresh.isVisible()) await refresh.click()
      await expect(page.getByText("Device verified.", { exact: true })).toBeVisible()
      expect(await peer("status", flowId)).toMatchObject({ state: "done", deviceVerified: true })
    })
  )
})

test("a reopened browser resumes sync and recovers the original native-encrypted pending event only after admission", async ({}, info) => {
  await withFixture(info, async (f) => {
    let page = await f.launch({ rawUnlock: false })
    const password = "Vault-native-" + randomBytes(24).toString("base64url")
    await page.evaluate(
      async ({ account, password }) => {
        await window.matrixFixture.vault.create(account, password)
        await window.matrixFixture.vault.storeCredential("fixture-bob")
      },
      { account, password }
    )
    await page.evaluate(async (origin) => {
      await window.matrixFixture.seedAdapter("bob", origin)
      await window.matrixFixture.patchCursor("bob", "initial-cursor")
    }, f.wire.origin)
    await page.evaluate(
      ({ origin, identity }) =>
        window.matrixFixture.start(origin, identity.userId, identity.deviceId, true),
      { origin: f.wire.origin, identity: native.identity("bob") }
    )
    await expect
      .poll(() => f.wire.requests.filter((r) => r.url.pathname.endsWith("/sync")).length)
      .toBeGreaterThan(0)
    await native.connectorsMatrixCryptoInit(native.identity("alice"))
    await dispatch(
      f.wire,
      "alice",
      (await native.connectorsMatrixCryptoOutgoingRequests("alice")).filter(
        (r) => r.kind === "keysUpload"
      )
    )
    await native.connectorsMatrixCryptoUpdateTrackedUsers({
      adapterId: "alice",
      userIds: [native.identity("bob").userId],
    })
    await dispatch(
      f.wire,
      "alice",
      (await native.connectorsMatrixCryptoOutgoingRequests("alice")).filter(
        (r) => r.kind === "keysQuery"
      )
    )
    await dispatch(
      f.wire,
      "alice",
      await native.connectorsMatrixCryptoGetMissingSessions({
        adapterId: "alice",
        userIds: [native.identity("bob").userId],
      })
    )
    await dispatch(
      f.wire,
      "alice",
      await native.connectorsMatrixCryptoShareRoomKey({
        adapterId: "alice",
        roomId: native.room,
        userIds: [native.identity("bob").userId],
      })
    )
    const encrypted = await native.connectorsMatrixCryptoEncryptEvent({
      adapterId: "alice",
      roomId: native.room,
      eventType: "m.room.message",
      content: { msgtype: "m.text", body: "native browser disk recovery" },
    })
    const timeline = {
      type: "m.room.encrypted",
      event_id: "$browser-native",
      sender: native.identity("alice").userId,
      origin_server_ts: 1,
      content: encrypted.content,
    }
    f.reply({
      next_batch: "persisted-sync-cursor",
      rooms: { join: { [native.room]: { timeline: { events: [timeline] } } } },
    })
    try {
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.matrixFixture.read("bob")).pending.length)
        )
        .toBe(1)
    } catch (error) {
      await info.attach("matrix-runtime-diagnostic", {
        contentType: "application/json",
        body: JSON.stringify([
          await page.evaluate(() => window.matrixFixture.diagnostics()),
          f.wire.requests.map((r) => ({
            path: r.url.pathname,
            since: r.url.searchParams.get("since"),
          })),
        ]),
      })
      throw error
    }
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.matrixFixture.read("bob")).row.settings.syncSinceToken
        )
      )
      .toBe("persisted-sync-cursor")
    expect(await page.evaluate(() => window.matrixFixture.events())).toEqual([])
    const original = (await page.evaluate(() => window.matrixFixture.read("bob"))).pending[0]
    await f.close(async () => {
      const late = await native.connectorsHttpRequest({
        url: f.wire.origin + "/_matrix/client/v3/sync?since=old-browser",
        method: "GET",
        headers: { authorization: "Bearer fixture-bob" },
      })
      expect(late.status).toBe(401)
    })
    page = await f.launch({ rawUnlock: false })
    expect(await page.evaluate(() => window.matrixFixture.vault.status())).toMatchObject({
      unlocked: false,
    })
    await page.evaluate(
      ({ account, password }) => window.matrixFixture.vault.unlock(account, password),
      { account, password }
    )
    expect((await page.evaluate(() => window.matrixFixture.read("bob"))).pending).toEqual([
      original,
    ])
    await page.evaluate(() => window.matrixFixture.reject(true))
    const requestOffset = f.wire.requests.length
    await page.evaluate(
      ({ origin, identity }) =>
        window.matrixFixture.start(origin, identity.userId, identity.deviceId, true),
      { origin: f.wire.origin, identity: native.identity("bob") }
    )
    await expect
      .poll(() =>
        f.wire.requests
          .slice(requestOffset)
          .find((r) => r.url.pathname.endsWith("/sync"))
          ?.url.searchParams.get("since")
      )
      .toBe("persisted-sync-cursor")
    const keys = f.relay.inbox.get(native.identity("bob").userId)
    expect(keys.length).toBeGreaterThan(0)
    f.reply({ next_batch: "keys-arrived", to_device: { events: keys } })
    await expect
      .poll(() => page.evaluate(() => window.matrixFixture.diagnostics().admissionRejections))
      .toBeGreaterThan(0)
    expect(
      (await page.evaluate(() => window.matrixFixture.read("bob"))).pending[0].lastError
    ).toContain("fixture-admission-rejected")
    expect(await page.evaluate(() => window.matrixFixture.events())).toEqual([])
    expect((await page.evaluate(() => window.matrixFixture.read("bob"))).pending[0].eventId).toBe(
      "$browser-native"
    )
    await page.evaluate(() => window.matrixFixture.reject(false))
    f.reply({ next_batch: "recovered", to_device: { events: keys } })
    await expect
      .poll(() => page.evaluate(() => window.matrixFixture.events()))
      .toEqual([
        { id: "!private:fixture.test|$browser-native", text: "native browser disk recovery" },
      ])
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.matrixFixture.read("bob")).pending.length)
      )
      .toBe(0)
    await page.evaluate(() => window.matrixFixture.stop())
  })
})

test("HTTP listen failure removes its owned profile and closes the already-started native process", async ({}, info) => {
  const profiles = path.resolve(".cache/test-results/matrix-browser/profiles")
  await fs.mkdir(profiles, { recursive: true })
  const before = await fs.readdir(profiles)
  const receipts = process.env.COGNIA_IM_NATIVE_REPORT_DIR
  const receiptFiles = new Set(await fs.readdir(receipts))
  await expect(
    withFixture(
      info,
      () => {
        throw new Error("unreachable fixture body")
      },
      { failListen: true }
    )
  ).rejects.toThrow(/port/)
  expect(await fs.readdir(profiles)).toEqual(before)
  const added = (await fs.readdir(receipts)).filter(
    (name) => !receiptFiles.has(name) && name.startsWith("process-")
  )
  expect(added).toHaveLength(1)
  const receipt = JSON.parse(await fs.readFile(path.join(receipts, added[0]), "utf8"))
  expect(receipt).toMatchObject({
    starts: 1,
    readyStarts: 1,
    lifecycle: "clean",
    profileRemoved: true,
    pendingAfterCleanup: 0,
    socketsAfterCleanup: 0,
    exit: { code: 0 },
  })
})

test("password-backed Vault unlock recovers Matrix rows and credentials after browser restart", async ({}, info) => {
  await withFixture(info, async (f) => {
    let page = await f.launch({ rawUnlock: false })
    const password = "Matrix-private-" + randomBytes(24).toString("base64url")
    const credential = "fixture-private-credential-" + randomBytes(16).toString("hex")
    const recovery = await page.evaluate(
      ({ account, password }) => window.matrixFixture.vault.create(account, password),
      { account, password }
    )
    await page.evaluate(
      async ({ origin, credential, pending }) => {
        await window.matrixFixture.seedAdapter("bob", origin)
        await window.matrixFixture.patchCursor("bob", "vault-disk-cursor")
        await window.matrixFixture.persist("bob", "!private:fixture.test", pending)
        await window.matrixFixture.vault.storeCredential(credential)
      },
      {
        origin: f.wire.origin,
        credential,
        pending: event("$vault-pending", "private-vault-payload"),
      }
    )
    const before = await page.evaluate(() => window.matrixFixture.read("bob"))
    const pendingRaw = await page.evaluate(() => window.matrixFixture.rawPending())
    expect(pendingRaw[0].__cogniaEncryptedContent).toMatchObject({
      accountId: account,
      algorithm: "AES-256-GCM",
    })
    expect(JSON.stringify(pendingRaw)).not.toContain("private-vault-payload")
    const raw = await page.evaluate(() => window.matrixFixture.vault.raw())
    expect(raw.vaults).toHaveLength(1)
    expect(raw.vaults[0].passwordKdf).toMatchObject({
      algorithm: "Argon2id",
      memoryKiB: 19456,
      timeCost: 2,
      parallelism: 1,
    })
    const rawAdapters = await page.evaluate(() => window.matrixFixture.rawAdapters())
    expect(rawAdapters[0]).toMatchObject({
      id: "bob",
      settings: { syncSinceToken: "vault-disk-cursor" },
    })
    for (const value of [password, credential, recovery]) {
      expect(JSON.stringify(raw)).not.toContain(value)
      expect(JSON.stringify(rawAdapters)).not.toContain(value)
    }
    await f.close()
    page = await f.launch({ rawUnlock: false })
    expect(await page.evaluate(() => window.matrixFixture.vault.status())).toMatchObject({
      unlocked: false,
    })
    await page.evaluate((account) => window.matrixFixture.vault.selectLocked(account), account)
    await expect(page.evaluate(() => window.matrixFixture.read("bob"))).rejects.toThrow()
    await expect(
      page.evaluate(({ account }) => window.matrixFixture.vault.unlock(account, "wrong-password"), {
        account,
      })
    ).rejects.toThrow()
    expect(await page.evaluate(() => window.matrixFixture.vault.raw())).toEqual(raw)
    expect(await page.evaluate(() => window.matrixFixture.rawPending())).toEqual(pendingRaw)
    expect(await page.evaluate(() => window.matrixFixture.vault.status())).toMatchObject({
      unlocked: false,
    })
    await page.evaluate(
      ({ account, password }) => window.matrixFixture.vault.unlock(account, password),
      { account, password }
    )
    expect(await page.evaluate(() => window.matrixFixture.read("bob"))).toEqual(before)
    expect(await page.evaluate(() => window.matrixFixture.vault.loadCredential())).toBe(credential)
  })
})

test("Vault password rotation and account-bound recovery keep the original Matrix ciphertext", async ({}, info) => {
  await withFixture(info, async (f) => {
    let page = await f.launch({ rawUnlock: false })
    const passwords = [0, 1, 2].map(() => "Vault-rotate-" + randomBytes(24).toString("base64url"))
    const recovery = await page.evaluate(
      ({ account, password }) => window.matrixFixture.vault.create(account, password),
      { account, password: passwords[0] }
    )
    const foreignRecovery = await page.evaluate(
      (password) => window.matrixFixture.vault.create("acct_foreign_vault", password, false),
      passwords[0]
    )
    const pending = event("$rotated-vault", "private-vault-rotation")
    await page.evaluate(
      async ({ pending, origin }) => {
        await window.matrixFixture.seedAdapter("bob", origin)
        await window.matrixFixture.persist("bob", "!private:fixture.test", pending)
        await window.matrixFixture.vault.storeCredential("fixture-rotation-token")
      },
      { pending, origin: f.wire.origin }
    )
    const original = await page.evaluate(() => window.matrixFixture.read("bob"))
    const ciphertext = await page.evaluate(() => window.matrixFixture.rawPending())
    await page.evaluate(
      ({ account, passwords }) =>
        window.matrixFixture.vault.rotate(account, passwords[0], passwords[1]),
      { account, passwords }
    )
    await page.evaluate(() => window.matrixFixture.vault.lock())
    const rotatedVault = await page.evaluate(() => window.matrixFixture.vault.raw())
    await expect(
      page.evaluate(
        ({ account, passwords }) => window.matrixFixture.vault.unlock(account, passwords[0]),
        { account, passwords }
      )
    ).rejects.toThrow()
    expect(await page.evaluate(() => window.matrixFixture.vault.raw())).toEqual(rotatedVault)
    expect(await page.evaluate(() => window.matrixFixture.rawPending())).toEqual(ciphertext)
    await page.evaluate(
      ({ account, passwords }) => window.matrixFixture.vault.unlock(account, passwords[1]),
      { account, passwords }
    )
    expect(await page.evaluate(() => window.matrixFixture.read("bob"))).toEqual(original)
    await expect(
      page.evaluate(
        ({ account, key, password }) => window.matrixFixture.vault.recover(account, key, password),
        { account, key: foreignRecovery, password: passwords[2] }
      )
    ).rejects.toThrow()
    expect(await page.evaluate(() => window.matrixFixture.vault.raw())).toEqual(rotatedVault)
    expect(await page.evaluate(() => window.matrixFixture.rawPending())).toEqual(ciphertext)
    await page.evaluate(
      ({ account, key, password }) => window.matrixFixture.vault.recover(account, key, password),
      { account, key: recovery, password: passwords[2] }
    )
    expect(await page.evaluate(() => window.matrixFixture.rawPending())).toEqual(ciphertext)
    await f.close()
    page = await f.launch({ rawUnlock: false })
    await expect(
      page.evaluate(
        ({ account, passwords }) => window.matrixFixture.vault.unlock(account, passwords[1]),
        { account, passwords }
      )
    ).rejects.toThrow()
    await page.evaluate(
      ({ account, passwords }) => window.matrixFixture.vault.unlock(account, passwords[2]),
      { account, passwords }
    )
    expect(await page.evaluate(() => window.matrixFixture.read("bob"))).toEqual(original)
    expect(await page.evaluate(() => window.matrixFixture.vault.loadCredential())).toBe(
      "fixture-rotation-token"
    )
  })
})

test("authenticated Vault wrap tampering refuses unlock without replacing Matrix data", async ({}, info) => {
  await withFixture(info, async (f) => {
    const page = await f.launch({ rawUnlock: false })
    const password = "Vault-tamper-" + randomBytes(24).toString("base64url")
    await page.evaluate(
      ({ account, password }) => window.matrixFixture.vault.create(account, password),
      { account, password }
    )
    const pending = event("$tamper-vault", "private-vault-tamper")
    await page.evaluate(
      (pending) => window.matrixFixture.persist("bob", "!private:fixture.test", pending),
      pending
    )
    const ciphertext = await page.evaluate(() => window.matrixFixture.rawPending())
    const before = await page.evaluate(() => window.matrixFixture.read("bob"))
    await page.evaluate(() => window.matrixFixture.vault.lock())
    await page.evaluate(
      (account) => window.matrixFixture.vault.corruptPasswordWrap(account),
      account
    )
    const corrupted = await page.evaluate(() => window.matrixFixture.vault.raw())
    await expect(
      page.evaluate(
        ({ account, password }) => window.matrixFixture.vault.unlock(account, password),
        { account, password }
      )
    ).rejects.toThrow()
    expect(await page.evaluate(() => window.matrixFixture.vault.raw())).toEqual(corrupted)
    expect(await page.evaluate(() => window.matrixFixture.rawPending())).toEqual(ciphertext)
    expect(await page.evaluate(() => window.matrixFixture.vault.status())).toMatchObject({
      unlocked: false,
    })
    await page.evaluate(
      (account) => window.matrixFixture.vault.corruptPasswordWrap(account),
      account
    )
    await page.evaluate(
      ({ account, password }) => window.matrixFixture.vault.unlock(account, password),
      { account, password }
    )
    expect(await page.evaluate(() => window.matrixFixture.read("bob"))).toEqual(before)
  })
})

test("a locked Vault credential resolver prevents new native HTTP dispatch", async ({}, info) => {
  await withFixture(info, async (f) => {
    const page = await f.launch({ rawUnlock: false })
    const password = "Vault-lock-" + randomBytes(24).toString("base64url")
    await page.evaluate(
      async ({ account, password, origin, identity }) => {
        await window.matrixFixture.vault.create(account, password)
        await window.matrixFixture.vault.storeCredential("fixture-bob")
        await window.matrixFixture.seedAdapter("bob", origin)
        await window.matrixFixture.start(origin, identity.userId, identity.deviceId, true)
      },
      { account, password, origin: f.wire.origin, identity: native.identity("bob") }
    )
    await expect
      .poll(() => f.wire.requests.filter((r) => r.url.pathname.endsWith("/sync")).length)
      .toBeGreaterThan(0)
    await page.evaluate(() => window.matrixFixture.vault.lock(false))
    const before = f.wire.requests.length
    await expect(page.evaluate(() => window.matrixFixture.bootstrap())).rejects.toThrow(
      "before dispatch"
    )
    expect(f.wire.requests).toHaveLength(before)
    await page.evaluate(() => window.matrixFixture.stop())
  })
})

test("locking during actual Vault token decryption prevents a late native request", async ({}, info) => {
  await withFixture(info, async (f) => {
    const page = await f.launch({ rawUnlock: false })
    const password = "Vault-race-" + randomBytes(24).toString("base64url")
    await page.evaluate(
      async ({ account, password, origin, identity }) => {
        await window.matrixFixture.vault.create(account, password)
        await window.matrixFixture.vault.storeCredential("fixture-bob")
        await window.matrixFixture.seedAdapter("bob", origin)
        await window.matrixFixture.start(origin, identity.userId, identity.deviceId, true)
      },
      { account, password, origin: f.wire.origin, identity: native.identity("bob") }
    )
    await expect
      .poll(() => f.wire.requests.filter((r) => r.url.pathname.endsWith("/sync")).length)
      .toBeGreaterThan(0)
    await page.evaluate(() => window.matrixFixture.vault.holdCredentialDecrypt())
    const operation = page
      .evaluate(() => window.matrixFixture.bootstrap())
      .then(
        () => "unexpected success",
        (error) => error.message
      )
    try {
      await page.evaluate(() => window.matrixFixture.vault.awaitCredentialDecrypt())
      const before = f.wire.requests.length
      await page.evaluate(() => window.matrixFixture.vault.lock(false))
      await page.evaluate(() => window.matrixFixture.vault.releaseCredentialDecrypt())
      expect(await operation).toContain("before dispatch")
      expect(f.wire.requests).toHaveLength(before)
      expect(await page.evaluate(() => window.matrixFixture.vault.status())).toMatchObject({
        unlocked: false,
      })
    } finally {
      await page.evaluate(() => window.matrixFixture.vault.releaseCredentialDecrypt())
      await operation
      await page.evaluate(() => window.matrixFixture.stop())
    }
  })
})
