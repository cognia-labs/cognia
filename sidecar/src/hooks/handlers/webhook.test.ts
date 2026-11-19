import type { AddressInfo } from "node:net"
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { runWebhookHandler } from "../agent-hooks.ts"

test("runWebhookHandler: 2xx JSON body parsed, non-2xx warns", async () => {
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ additionalContext: `saw:${body}` }))
      } else {
        res.writeHead(500)
        res.end("boom")
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as AddressInfo).port
  try {
    const ok = await runWebhookHandler(`http://127.0.0.1:${port}/ok`, {}, 5, '{"x":1}')
    assert.equal(ok.additionalContext, 'saw:{"x":1}')
    const bad = await runWebhookHandler(`http://127.0.0.1:${port}/err`, undefined, 5, "{}")
    assert.match(bad.warning!, /500/)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test("runWebhookHandler: redacts a PII-bearing lifecycle payload before fetch", async () => {
  let received = ""
  const server = http.createServer((req, res) => {
    req.on("data", (chunk) => (received += chunk))
    req.on("end", () => {
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    const out = await runWebhookHandler(
      `http://127.0.0.1:${port}/hook`,
      undefined,
      5,
      JSON.stringify({ prompt: "email alice@example.com" })
    )
    assert.equal(out.block, undefined)
    assert.doesNotMatch(received, /alice@example\.com/)
    assert.match(received, /<EMAIL_001>/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("runWebhookHandler: sends custom headers with the JSON POST body", async () => {
  let received: { method?: string; contentType?: string; hookKey?: string; body: string }
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      received = {
        method: req.method,
        contentType: req.headers["content-type"],
        hookKey: req.headers["x-hook-key"] as string | undefined,
        body,
      }
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    const out = await runWebhookHandler(
      `http://127.0.0.1:${port}/hook`,
      { "x-hook-key": "test-hook-key" },
      5,
      '{"event":"ready"}'
    )
    assert.equal(out.warning, undefined)
    assert.deepEqual(received!, {
      method: "POST",
      contentType: "application/json",
      hookKey: "test-hook-key",
      body: '{"event":"ready"}',
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("runWebhookHandler: a pre-aborted signal prevents the HTTP request", async () => {
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests += 1
    res.writeHead(204)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const controller = new AbortController()
  controller.abort(new Error("caller cancelled"))
  try {
    const out = await runWebhookHandler(
      `http://127.0.0.1:${port}/hook`,
      undefined,
      5,
      "{}",
      controller.signal
    )
    assert.equal(requests, 0)
    assert.match(out.warning!, /caller cancelled/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("runWebhookHandler: caller cancellation during the request stays distinct from a timeout", async () => {
  const controller = new AbortController()
  let requests = 0
  const server = http.createServer((req, res) => {
    requests += 1
    req.resume()
    req.on("end", () => {
      controller.abort()
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    const out = await runWebhookHandler(
      `http://127.0.0.1:${port}/hook`,
      undefined,
      5,
      "{}",
      controller.signal
    )
    assert.equal(requests, 1)
    assert.match(out.warning!, /failed:.*abort/i)
    assert.doesNotMatch(out.warning!, /timed out/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
