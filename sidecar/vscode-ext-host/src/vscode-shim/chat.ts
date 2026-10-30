/**
 * `vscode.chat` — chat participants + variable resolvers.
 *
 * Each participant becomes a virtual cognia Character.
 */

import { Disposable } from "./types"
import type { ShimDependencies } from "./index"
import { MarkdownString } from "./types"
import {
  ChatRequestTurn,
  ChatResponseTurn,
  ChatResponseMarkdownPart,
  ChatResponseProgressPart,
  ChatResponseReferencePart,
} from "./value-types"
import { createChatModel } from "./lm"

let participantSequence = 0

export function createChatNamespace(deps: ShimDependencies) {
  const { connection, extensionId, registerProviderCallback } = deps
  return {
    createChatParticipant(
      id: string,
      handler: (request: unknown, context: unknown, stream: unknown, token: unknown) => unknown
    ) {
      const token = `chat:${extensionId}:${id}:${++participantSequence}:${globalThis.crypto.randomUUID()}`
      const unregister = registerProviderCallback(token, async (payload, call) => {
        const p = payload as {
          requestId: string
          request: unknown
          context?: {
            history?: Array<{
              request?: { prompt: string }
              response?: Array<{ kind: string; value: string }>
              participant: string
              result?: unknown
            }>
          }
        }
        let pending = Promise.resolve()
        let closed = false
        const send = (kind: string, value: string) => {
          if (closed || call.cancellation.isCancellationRequested)
            throw new Error("Chat participant response is closed")
          pending = pending.then(async () => {
            if (call.cancellation.isCancellationRequested)
              throw new Error("Chat participant cancelled")
            await connection.sendRequest("chat:respond", {
              extensionId,
              id,
              requestId: p.requestId,
              part: { kind, value },
            })
          })
          void pending.catch(() => {})
          return stream
        }
        const stream = {
          markdown: (value: string | MarkdownString) =>
            send("markdown", typeof value === "string" ? value : value.value),
          progress: (value: string) => send("progress", value),
          reference: (value: {
            toString(): string
            uri?: { toString(): string }
            range?: unknown
          }) => {
            const url = (value.uri ?? value).toString()
            if (value.range || !/^https?:\/\//i.test(url))
              throw new Error("Cognia chat references currently support HTTP(S) URLs only")
            return send("reference", url)
          },
          push: (part: unknown) => {
            if (part instanceof ChatResponseMarkdownPart) return stream.markdown(part.value)
            if (part instanceof ChatResponseProgressPart) return stream.progress(part.value)
            if (part instanceof ChatResponseReferencePart) return stream.reference(part.value)
            throw new Error("This chat response part is not supported by Cognia")
          },
        }
        const context = {
          history: (p.context?.history ?? []).map((turn) =>
            turn.request
              ? new ChatRequestTurn(turn.request.prompt, undefined, [], turn.participant)
              : new ChatResponseTurn(
                  (turn.response ?? []).map((part) => new ChatResponseMarkdownPart(part.value)),
                  turn.result ?? {},
                  turn.participant
                )
          ),
        }
        try {
          const models = await connection.sendRequest<Parameters<typeof createChatModel>[0][]>(
            "lm:selectChatModels",
            { extensionId, selector: {} }
          )
          const selected = Array.isArray(models) ? models[0] : undefined
          if (selected) deps.languageModels.remember(models)
          const request = {
            ...(p.request as Record<string, unknown>),
            ...(selected ? { model: createChatModel(selected, deps) } : {}),
          }
          const result = await handler(request, context, stream, call.cancellation)
          await pending
          return result
        } finally {
          closed = true
        }
      })
      const registration = connection.sendRequest("chat:createParticipant", {
        extensionId,
        id,
        token,
      })
      deps.trackRegistration?.(registration)
      void registration.catch((error) =>
        console.error("Chat participant registration failed", error)
      )
      return {
        id,
        fullName: id,
        name: id,
        iconPath: undefined as unknown,
        followupProvider: undefined as unknown,
        onDidReceiveFeedback: () => new Disposable(() => {}),
        dispose: () => {
          unregister()
          void registration
            .then(() =>
              connection.sendRequest("chat:disposeParticipant", { extensionId, id, token })
            )
            .catch(() => {})
        },
      }
    },
    registerChatVariableResolver(
      id: string,
      resolver: { resolve: (...args: unknown[]) => unknown }
    ) {
      const token = `chatVar:${extensionId}:${id}`
      const unregister = registerProviderCallback(token, (payload) => resolver.resolve(payload))
      void connection.sendRequest("chat:registerChatVariableResolver", {
        extensionId,
        id,
        token,
      })
      return new Disposable(() => {
        unregister()
        void connection.sendNotification("chat:unregisterChatVariableResolver", {
          extensionId,
          id,
        })
      })
    },
  }
}
