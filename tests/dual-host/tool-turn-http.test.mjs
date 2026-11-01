// Smoke both actual HTTP servers without Docker, Tauri, esbuild or SWC.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import Module from "node:module"
import { createServer } from "node:net"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout } from "node:timers/promises"
import { test } from "node:test"
import ts from "typescript"
import {
  TOOL_TURN_MARKER,
  TOOL_TURN_ID,
  toolTurnResponse,
} from "../real-e2e/scenarios/tool-turn.mjs"

async function unusedPort() {
  const listener = createServer()
  listener.listen(0, "127.0.0.1")
  await once(listener, "listening")
  const port = listener.address().port
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

async function exercise(baseURL) {
  const prompt = { role: "user", content: TOOL_TURN_MARKER }
  const result = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: TOOL_TURN_ID, content: "Todos updated" }],
  }
  for (const stream of [false, true]) {
    for (const messages of [[prompt], [prompt, result]]) {
      const request = { model: "claude-e2e", max_tokens: 256, messages, stream }
      const response = await fetch(`${baseURL}/v1/messages?beta=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      })
      assert.equal(response.status, 200)
      const text = await response.text()
      // Keep the exact wire response in the local/CI test log for review.
      console.log(`${baseURL}: stream=${stream}, followUp=${messages.length === 2}\n${text}`)
      const expected = toolTurnResponse(request)
      if (stream) {
        assert.match(response.headers.get("content-type"), /text\/event-stream/)
        assert.equal(text, expected.sse)
      } else {
        assert.deepEqual(JSON.parse(text), expected.message)
      }
    }
  }
}

test(
  "Compose fixture serves the tool turn and retains its existing text and auxiliary routes",
  { timeout: 15_000 },
  async (t) => {
    const port = await unusedPort()
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../real-e2e/anthropic-fixture.mjs", import.meta.url))],
      {
        env: { ...process.env, PORT: String(port) },
        stdio: ["ignore", "ignore", "pipe"],
      }
    )
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    t.after(async () => {
      if (child.exitCode !== null) return
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      await exited
    })
    const url = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) throw new Error(`Fixture exited: ${stderr}`)
      try {
        ready = (await fetch(`${url}/healthz`)).status === 204
      } catch {
        /* child is still starting */
      }
      if (ready) break
      await setTimeout(100)
    }
    assert.ok(ready, `Fixture did not start: ${stderr}`)
    await exercise(url)
    const ordinary = await fetch(`${url}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    })
    assert.equal(
      (await ordinary.json()).content[0].text,
      "[web-headless-e2e] deterministic assistant reply"
    )
    assert.equal((await fetch(`${url}/v1/models`)).status, 200)
    const count = await fetch(`${url}/v1/messages/count_tokens?beta=true`, {
      method: "POST",
      body: "{}",
    })
    assert.deepEqual(await count.json(), { input_tokens: 1 })
    assert.equal((await fetch(`${url}/v1/messages`, { method: "POST", body: "{" })).status, 400)
  }
)

test(
  "Tauri mock serves the identical wire scenario and keeps scenario/control semantics",
  { timeout: 15_000 },
  async (t) => {
    // Its production runner is Playwright's TS transform. For this standalone
    // HTTP smoke use TypeScript's JS-only transform to load the same source.
    const filename = fileURLToPath(new URL("../e2e/mocks/anthropic/server.ts", import.meta.url))
    const compiled = new Module(filename)
    compiled.filename = filename
    compiled.paths = Module._nodeModulePaths(dirname(filename))
    compiled._compile(
      ts.transpileModule(readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: filename,
      }).outputText,
      filename
    )
    const server = compiled.exports.createMockAnthropicServer()
    await server.start()
    t.after(() => server.stop())
    await exercise(server.baseUrl)
    assert.equal(server.messagesCalls.length, 4)
    server.setMessagesScenario({ kind: "canned", text: "existing canned reply" })
    const ordinary = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model", messages: [{ role: "user", content: "hello" }] }),
    })
    assert.equal((await ordinary.json()).content[0].text, "existing canned reply")
    server.setMessagesScenario({ kind: "auth-error" })
    const denied = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model", messages: [{ role: "user", content: "hello" }] }),
    })
    assert.equal(denied.status, 401)
    await denied.text()
    server.reset()
    assert.equal(server.messagesCalls.length, 0)
  }
)
