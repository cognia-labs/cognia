import { definePrompt } from "@/lib/prompts/types"

/**
 * The identity a persona-less tool-enabled run gets when its caller supplied
 * no system prompt of its own (ADR-0236). A caller's `systemPrompt` always
 * wins; this only fills the gap.
 */
export const EXECUTOR_FALLBACK_PROMPT = definePrompt({
  id: "agent.executor.fallback",
  contractVersion: 1,
  kind: "role",
  group: "agents",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["app"],
  maxChars: 8_000,
  outputContract:
    "The system prompt of the synthesized agent for an `executeAgent` run with tools, no agent and no caller-supplied system prompt.",
  consumers: ["lib/ai/agent/agent-executor.ts"],
  defaultBody: "You are a focused, helpful agent.",
})
