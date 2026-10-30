// `vscode.lm` through the real host: the test plays the renderer, describing
// the app's model and answering the host's reads of each response.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.ts"

const ID = "cognia.lm-extension"
const PATH = join(FIXTURES, "lm-extension")

const MODEL = {
  id: "cognia/fixture",
  name: "Fixture Model",
  vendor: "cognia",
  family: "fixture",
  version: "fixture",
  maxInputTokens: 4096,
  canSendRequest: true,
}

/**
 * `send` answers `lm:sendChatRequest`; `reads` is what each
 * `lm:readChatResponse` answers, in order (a function waits on the test).
 */
async function startLm({ send = () => ({ ok: true }), reads = [], models = [MODEL] }: any = {}) {
  const commands = new Map()
  const requests: any[] = []
  const queue = [...reads]
  const tools = new Map<string, string>()
  const host = startHost(ID, (method: any, params: any) => {
    requests.push({ method, params })
    if (method === "commands:register") {
      commands.set(params.command, params.token)
      return { registered: true }
    }
    if (method === "chat:createParticipant")
      return { characterId: "vscode-chat:" + ID + ":" + params.id }
    if (method === "chat:disposeParticipant" || method === "chat:respond") return null
    if (method === "lm:selectChatModels") {
      return models.filter(
        (model: any) =>
          params.selector.vendor === undefined || params.selector.vendor === model.vendor
      )
    }
    if (method === "lm:sendChatRequest") return send(params)
    if (method === "lm:readChatResponse") {
      const next = queue.shift() ?? { text: "", done: true }
      return typeof next === "function" ? next(params) : next
    }
    if (method === "lm:countTokens") return params.text.split(" ").length
    if (method === "lm:cancelChatRequest") return null
    if (method === "lm:listTools") return [...tools.keys()].map((name) => ({ name }))
    if (method === "lm:registerTool") {
      tools.set(params.name, params.token)
      void host.request("lm:toolsChanged", { tools: [...tools.keys()].map((name) => ({ name })) })
      return { registered: true }
    }
    if (method === "lm:unregisterTool") {
      if (tools.get(params.name) === params.token) tools.delete(params.name)
      return null
    }
    if (method === "lm:invokeTool") {
      const token = tools.get(params.name)
      if (!token) throw new Error(`Tool ${params.name} not found`)
      return host.request("extension:call", {
        token,
        method: "invoke",
        callId: params.callId,
        payload: { input: params.input },
      })
    }
    if (method.startsWith("lm:register")) return { registered: false }
    return null
  })
  await host.request("extension:load", {
    extensionId: ID,
    extensionPath: PATH,
    main: "./extension.js",
    bundleFormat: "cjs",
    grantedModules: [] as any[],
  })
  await host.request("extension:activate", activation(ID, PATH))
  const run = (command: any) =>
    host.request("extension:call", {
      extensionId: ID,
      token: commands.get(command),
      payload: [] as any[],
    })
  const sent = (method: any) => requests.filter((entry: any) => entry.method === method)
  return { host, run, sent }
}

test("selectChatModels hands back working models, and access follows what the renderer said", async () => {
  const { host, run, sent } = await startLm()
  try {
    assert.deepEqual(await run("lmFixture.select"), {
      id: "cognia/fixture",
      name: "Fixture Model",
      vendor: "cognia",
      family: "fixture",
      version: "fixture",
      maxInputTokens: 4096,
      methods: ["function", "function"],
      before: "undefined",
      after: true,
      none: [] as any[],
    })
    assert.deepEqual(sent("lm:selectChatModels")[0].params, {
      extensionId: ID,
      selector: { vendor: "cognia" },
    })
  } finally {
    host.stop()
  }
})

test("sendRequest streams the reply in order; text and stream each replay it", async () => {
  const { host, run, sent } = await startLm({
    reads: [
      { text: "Hello", done: false },
      { text: ", ", done: false },
      { text: "world", done: true },
    ],
  })
  try {
    assert.deepEqual(await run("lmFixture.ask"), {
      text: "Hello, world",
      parts: [
        { isTextPart: true, value: "Hello" },
        { isTextPart: true, value: ", " },
        { isTextPart: true, value: "world" },
      ],
    })
    const [request] = sent("lm:sendChatRequest")
    assert.equal(request.params.extensionId, ID)
    assert.equal(request.params.modelId, "cognia/fixture")
    assert.deepEqual(request.params.messages, [
      { role: "user", content: "Say hello" },
      { role: "assistant", content: "Hello?" },
    ])
    assert.deepEqual(request.params.options, {
      justification: "a test",
      modelOptions: { temperature: 0 },
      toolCount: 0,
    })
    // Every read names the request the host started.
    assert.deepEqual(
      new Set(sent("lm:readChatResponse").map((entry: any) => entry.params.requestId)),
      new Set([request.params.requestId])
    )
  } finally {
    host.stop()
  }
})

test("a refused request throws the LanguageModelError the renderer named", async () => {
  for (const code of ["NoPermissions", "Blocked", "NotFound"]) {
    const { host, run } = await startLm({
      send: () => ({ error: { code, message: `refused: ${code}` } }),
    })
    try {
      assert.deepEqual(await run("lmFixture.refused"), {
        name: "LanguageModelError",
        code,
        message: `refused: ${code}`,
        isLanguageModelError: true,
        isCancellation: false,
      })
    } finally {
      host.stop()
    }
  }
})

test("a failure mid-reply ends the stream with that error, after the text so far", async () => {
  const { host, run } = await startLm({
    reads: [
      { text: "partial", done: false },
      { text: "", done: true, error: { code: "Blocked", message: "rate limited" } },
    ],
  })
  try {
    const result = await run("lmFixture.failsMidway")
    assert.equal(result.text, "partial")
    assert.equal(result.error.code, "Blocked")
    assert.equal(result.error.message, "rate limited")
    assert.equal(result.error.isLanguageModelError, true)
  } finally {
    host.stop()
  }
})

test("cancelling the token ends the reply with a CancellationError and tells the renderer", async () => {
  let release
  const { host, run, sent } = await startLm({
    reads: [
      { text: "first", done: false },
      // The renderer holds the next read until the cancel arrives.
      () => new Promise<any>((resolve: any) => (release = resolve)),
    ],
  })
  try {
    const result = await run("lmFixture.cancel")
    assert.equal(result.text, "first")
    assert.equal(result.error.isCancellation, true)
    const [cancel] = sent("lm:cancelChatRequest")
    assert.equal(cancel.params.requestId, sent("lm:sendChatRequest")[0].params.requestId)
    release!({ text: "", done: true, error: { code: "Cancelled", message: "Canceled" } })
  } finally {
    host.stop()
  }
})

test("messages with tool parts are refused before anything is sent", async () => {
  const { host, run, sent } = await startLm()
  try {
    assert.match(await run("lmFixture.toolParts"), /LanguageModelToolCallPart is not supported/)
    assert.equal(sent("lm:sendChatRequest").length, 0)
  } finally {
    host.stop()
  }
})

test("countTokens counts strings and messages through the renderer", async () => {
  const { host, run, sent } = await startLm()
  try {
    assert.deepEqual(await run("lmFixture.count"), [3, 2])
    assert.deepEqual(
      sent("lm:countTokens").map((entry: any) => entry.params.text),
      ["one two three", "four five"]
    )
  } finally {
    host.stop()
  }
})

test("tools register and invoke the real extension callback through the host", async () => {
  const { host, run, sent } = await startLm()
  try {
    assert.deepEqual(await run("lmFixture.tools"), {
      tools: ["fixture_search"],
      content: ["found:hello"],
      toolMode: 2,
    })
    assert.equal(sent("lm:registerTool")[0].params.name, "fixture_search")
    assert.equal(typeof sent("lm:registerTool")[0].params.token, "string")
    assert.deepEqual(sent("lm:invokeTool")[0].params.input, { query: "hello" })
  } finally {
    host.stop()
  }
})

test("lm:modelsChanged fires both change events and updates access", async () => {
  const { host, run } = await startLm()
  try {
    await run("lmFixture.select")
    await host.request("lm:modelsChanged", { models: [{ ...MODEL, canSendRequest: false }] })
    assert.deepEqual(await run("lmFixture.changes"), {
      modelsChanged: 1,
      accessChanged: 1,
      canSend: false,
    })
    await host.request("lm:modelsChanged", { models: [] as any[] })
    const after = await run("lmFixture.changes")
    assert.equal(after.modelsChanged, 2)
    assert.equal(after.canSend, undefined)
  } finally {
    host.stop()
  }
})

test("chat participants receive local stream and history objects over the real callback transport", async () => {
  const { host, sent, run } = await startLm()
  try {
    const registration = sent("chat:createParticipant")[0].params
    const result = await host.request("extension:call", {
      token: registration.token,
      method: "respond",
      callId: "participant-call",
      payload: {
        requestId: "response-owner",
        request: { prompt: "world" },
        context: { history: [{ request: { prompt: "before" }, participant: "fixture.helper" }] },
      },
    })
    assert.deepEqual(result, {
      metadata: { historyLength: 1, typedHistory: true, model: MODEL.id },
    })
    assert.deepEqual(
      sent("chat:respond").map((entry: any) => ({
        requestId: entry.params.requestId,
        part: entry.params.part,
      })),
      [
        { requestId: "response-owner", part: { kind: "progress", value: "Working" } },
        { requestId: "response-owner", part: { kind: "markdown", value: "Hello " } },
        { requestId: "response-owner", part: { kind: "markdown", value: "world" } },
        {
          requestId: "response-owner",
          part: { kind: "reference", value: "https://example.com/source" },
        },
      ]
    )
    await run("lmFixture.disposeParticipant")
    await assert.rejects(
      host.request("extension:call", { token: registration.token, payload: {} }),
      /callback|Unknown|not found/i
    )
  } finally {
    host.stop()
  }
})

test("chat participants use the extension call cancellation token", async () => {
  const { host, sent } = await startLm()
  try {
    const registration = sent("chat:createParticipant")[0].params
    const result = host.request("extension:call", {
      token: registration.token,
      method: "respond",
      callId: "cancel-participant",
      payload: {
        requestId: "cancel-response",
        request: { prompt: "cancel" },
        context: { history: [] },
      },
    })
    const deadline = Date.now() + 3000
    while (!sent("chat:respond").length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(sent("chat:respond").length, "participant did not start before the deadline")
    await host.request("extension:cancel", { callId: "cancel-participant" })
    assert.deepEqual(await result, { metadata: { cancelled: true } })
  } finally {
    host.stop()
  }
})

for (const delayedMethod of [
  "chat:createParticipant",
  "lm:registerTool",
  "tasks:registerProvider",
]) {
  test(
    `activation waits for ${delayedMethod} registration acknowledgement`,
    { timeout: 5000 },
    async () => {
      const commands = new Map<string, string>()
      let release!: (value: unknown) => void
      let notify!: () => void
      const registrationStarted = new Promise<void>((resolve) => {
        notify = resolve
      })
      const host = startHost(
        ID,
        (method: string, params: any) => {
          if (method === "commands:register") {
            commands.set(params.command, params.token)
            return { registered: true }
          }
          if (method === delayedMethod) {
            const pending = new Promise((resolve) => {
              release = resolve
            })
            notify()
            return pending
          }
          return null
        },
        { env: { COGNIA_TEST_REGISTER_ON_ACTIVATE: "1" } }
      )
      try {
        await host.request("extension:load", {
          extensionId: ID,
          extensionPath: PATH,
          main: "./extension.js",
          bundleFormat: "cjs",
          grantedModules: [],
        })
        let activated = false
        const activationResult = host
          .request("extension:activate", activation(ID, PATH))
          .then((result: unknown) => {
            activated = true
            return result
          })
        await registrationStarted
        const deadline = Date.now() + 3000
        while (!commands.has("lmFixture.activationProbe") && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 5))
        assert.ok(commands.has("lmFixture.activationProbe"))
        assert.equal(
          await host.request("extension:call", {
            token: commands.get("lmFixture.activationProbe"),
            payload: [],
          }),
          "ready"
        )
        assert.equal(activated, false)
        release({ registered: true })
        await activationResult
        assert.equal(activated, true)
      } finally {
        release?.({ registered: false })
        host.stop()
      }
    }
  )
}
