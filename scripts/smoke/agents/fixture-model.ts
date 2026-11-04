/**
 * A deterministic OpenAI-compatible model on loopback. Smokes point a real
 * agent at it so a run needs no provider account and every reply, tool call
 * and model choice is scripted and observable.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export interface FixtureToolCall {
  id: string
  name: string
  /** JSON-encoded arguments, as the wire carries them. */
  arguments: string
}

export interface FixtureTurn {
  text?: string
  toolCalls?: FixtureToolCall[]
}

export interface FixtureRequest {
  path: string
  model: string
  /** Every message the agent sent, in order. */
  messages: Array<{ role: string; content: unknown }>
  /** Names of the tools the agent offered. */
  tools: string[]
  stream: boolean
  body: Record<string, unknown>
}

export interface FixtureModelOptions {
  /** Model ids served by GET /v1/models. */
  models?: string[]
  /** The scripted answer to one chat-completions request. */
  reply: (request: FixtureRequest) => FixtureTurn | Promise<FixtureTurn>
  /** Serve a path the fixture does not know; return true when handled. */
  route?: (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>
}

export interface FixtureModel {
  /** Base URL ending in /v1. */
  baseUrl: string
  /** Every chat-completions request received, in order. */
  requests: FixtureRequest[]
  close(): Promise<void>
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
}

/** The chunks a streaming chat completion sends for `turn`. */
export function completionChunks(model: string, turn: FixtureTurn): Record<string, unknown>[] {
  const toolCalls = turn.toolCalls ?? []
  const delta = toolCalls.length
    ? {
        role: "assistant",
        tool_calls: toolCalls.map((call, index) => ({
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      }
    : { role: "assistant", content: turn.text ?? "" }
  const base = { id: "fixture-completion", object: "chat.completion.chunk", created: 1, model }
  return [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]
}

/** The non-streaming chat completion for `turn`. */
export function completionBody(model: string, turn: FixtureTurn): Record<string, unknown> {
  const toolCalls = turn.toolCalls ?? []
  return {
    id: "fixture-completion",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length ? null : (turn.text ?? ""),
          ...(toolCalls.length
            ? {
                tool_calls: toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

export async function startFixtureModel(options: FixtureModelOptions): Promise<FixtureModel> {
  const requests: FixtureRequest[] = []
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(
          JSON.stringify({
            object: "list",
            data: (options.models ?? ["fixture"]).map((id) => ({
              id,
              object: "model",
              owned_by: "fixture",
            })),
          })
        )
        return
      }
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = await readJson(request)
        const fixtureRequest: FixtureRequest = {
          path: url.pathname,
          model: String(body.model ?? ""),
          messages: (body.messages as FixtureRequest["messages"]) ?? [],
          tools: ((body.tools as Array<{ function?: { name?: string } }>) ?? []).flatMap((tool) =>
            tool.function?.name ? [tool.function.name] : []
          ),
          stream: body.stream === true,
          body,
        }
        requests.push(fixtureRequest)
        const turn = await options.reply(fixtureRequest)
        if (!fixtureRequest.stream) {
          response.writeHead(200, { "Content-Type": "application/json" })
          response.end(JSON.stringify(completionBody(fixtureRequest.model, turn)))
          return
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const chunk of completionChunks(fixtureRequest.model, turn))
          response.write(`data: ${JSON.stringify(chunk)}\n\n`)
        response.end("data: [DONE]\n\n")
        return
      }
      if (await options.route?.(request, response)) return
      response.writeHead(404).end()
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
