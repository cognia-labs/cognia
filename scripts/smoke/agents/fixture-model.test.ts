/** @jest-environment node */
import { completionBody, completionChunks, startFixtureModel } from "./fixture-model"

describe("fixture model", () => {
  it("renders text and tool-call turns in both wire shapes", () => {
    expect(completionChunks("m", { text: "hi" })[0]).toMatchObject({
      model: "m",
      choices: [{ delta: { role: "assistant", content: "hi" }, finish_reason: null }],
    })
    const tool = { id: "t1", name: "write", arguments: '{"path":"a"}' }
    expect(completionChunks("m", { toolCalls: [tool] })[1]).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }],
    })
    expect(completionBody("m", { toolCalls: [tool] })).toMatchObject({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "t1", function: { name: "write", arguments: '{"path":"a"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
  })

  it("serves models, records requests and streams the scripted reply", async () => {
    const model = await startFixtureModel({
      models: ["fixture-a"],
      reply: (request) => ({ text: `echo:${request.model}:${request.tools.join(",")}` }),
      route: (request, response) => {
        if (request.url !== "/custom") return false
        response.writeHead(204).end()
        return true
      },
    })
    try {
      const models = await (await fetch(`${model.baseUrl}/models`)).json()
      expect(models.data.map((entry: { id: string }) => entry.id)).toEqual(["fixture-a"])

      const plain = await fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "fixture-a",
          messages: [{ role: "user", content: "x" }],
          tools: [{ function: { name: "read" } }],
        }),
      })
      expect((await plain.json()).choices[0].message.content).toBe("echo:fixture-a:read")

      const streamed = await fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture-a", messages: [], stream: true }),
      })
      expect(streamed.headers.get("content-type")).toBe("text/event-stream")
      const text = await streamed.text()
      expect(text).toContain('"content":"echo:fixture-a:"')
      expect(text.trim().endsWith("data: [DONE]")).toBe(true)

      expect(model.requests.map((request) => request.stream)).toEqual([false, true])
      expect(model.requests[0].messages).toEqual([{ role: "user", content: "x" }])
      expect((await fetch(model.baseUrl.replace("/v1", "/custom"))).status).toBe(204)
      expect((await fetch(`${model.baseUrl}/unknown`)).status).toBe(404)
    } finally {
      await model.close()
    }
  })

  it("answers 500 when the script throws", async () => {
    const model = await startFixtureModel({
      reply: () => {
        throw new Error("scripted failure")
      },
    })
    try {
      const response = await fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        body: "{}",
      })
      expect(response.status).toBe(500)
      expect(await response.text()).toBe("scripted failure")
    } finally {
      await model.close()
    }
  })
})
