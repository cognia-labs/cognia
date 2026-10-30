import { EXECUTOR_FALLBACK_PROMPT } from "./executor"
import { validatePromptBody } from "@/lib/prompts/template"

it("owns the executor identity independently of its execution runtime", () => {
  expect(EXECUTOR_FALLBACK_PROMPT).toMatchObject({
    id: "agent.executor.fallback",
    defaultBody: "You are a focused, helpful agent.",
    consumers: ["lib/ai/agent/agent-executor.ts"],
  })
  expect(
    validatePromptBody(EXECUTOR_FALLBACK_PROMPT, EXECUTOR_FALLBACK_PROMPT.defaultBody)
  ).toEqual([])
})
