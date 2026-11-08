// The `a2ui-system-prompt` capability port (ADR-0250 §14): the system-prompt
// section that teaches a turn's agent the A2UI protocol and, when the agent
// renders with a custom catalog, the component types that catalog adds. The
// a2ui module provides it (`lib/a2ui/ports/system-prompt.ts`). The send
// resolver appends it to `appendSystemPrompt` on a turn with A2UI enabled,
// ahead of the channel's capability prompt; with no provider the turn carries
// no A2UI section.

export interface A2UISystemPromptPort {
  /** The section for an agent whose surfaces render with `catalogId`. */
  systemSection(input: { catalogId?: string }): string
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "a2ui-system-prompt": A2UISystemPromptPort
  }
}
