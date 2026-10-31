"use client"

import { useEffect, useState } from "react"
import {
  resolveConnectionPrompt,
  subscribeConnectionPrompts,
  type ConnectionPromptState,
} from "@/lib/plugin/auth/connection-prompts"
import { ConnectionPickerDialog } from "./connection-picker-dialog"
import { ConnectionGrantDialog } from "./connection-grant-dialog"

export function PluginConnectionPromptHost() {
  const [state, setState] = useState<ConnectionPromptState>({ current: null, queue: [] })
  useEffect(() => subscribeConnectionPrompts(setState), [])
  const request = state.current
  if (!request) return null
  const onDismiss = () => resolveConnectionPrompt(request.id, { kind: "dismissed" })
  return request.kind === "picker" ? (
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
