"use client"

import { useEffect, useState } from "react"
import {
  resolveConnectionPrompt,
  subscribeConnectionPrompts,
  type ConnectionPromptState,
} from "@/lib/plugin/auth/connection-prompts"
import { ConnectionPickerDialog } from "./connection-picker-dialog"
import { ConnectionGrantDialog } from "./connection-grant-dialog"
import { ConnectionSignInDialog } from "./connection-sign-in-dialog"
import { startHostAuthCallbackListeners } from "@/lib/plugin/auth/callback-acceptor"

export function PluginConnectionPromptHost() {
  const [state, setState] = useState<ConnectionPromptState>({ current: null, queue: [] })
  useEffect(() => subscribeConnectionPrompts(setState), [])
  // This surface is mounted by AppRuntime on both desktop and web. Waiters
  // also retain listeners independently until their own attempt settles.
  useEffect(() => startHostAuthCallbackListeners(), [])
  const request = state.current
  if (!request) return null
  const onDismiss = () => resolveConnectionPrompt(request.id, { kind: "dismissed" })
  return request.kind === "sign-in" ? (
    <ConnectionSignInDialog
      key={request.id}
      pluginName={request.pluginName}
      providerLabel={request.providerLabel}
      scopes={request.scopes}
      onDismiss={onDismiss}
      onSignIn={() => resolveConnectionPrompt(request.id, { kind: "sign-in" })}
    />
  ) : request.kind === "picker" ? (
    <ConnectionPickerDialog
      key={request.id}
      pluginName={request.pluginName}
      candidates={request.candidates}
      onDismiss={onDismiss}
      onSelect={(ref) => resolveConnectionPrompt(request.id, { kind: "selected", ref })}
    />
  ) : (
    <ConnectionGrantDialog
      key={request.id}
      pluginName={request.pluginName}
      connection={request.connection}
      operations={request.operations}
      scopes={request.scopes}
      onDismiss={onDismiss}
      onApprove={() => resolveConnectionPrompt(request.id, { kind: "approved" })}
      onDecline={() => resolveConnectionPrompt(request.id, { kind: "denied" })}
    />
  )
}
