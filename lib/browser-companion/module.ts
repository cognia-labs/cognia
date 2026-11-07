import { defineHostModule } from "@/lib/modules/define"

// Browser Companion (ADR-0154, ADR-0228): the paired browser extension's host
// side, its agent mode and the browser context it hands a conversation.
export default defineHostModule({
  id: "browser-companion",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["agent-tasks", "appearance", "browser", "external-bridge", "issues", "share"],
  // The socket the browser engine talks through, and the agent runtime the
  // desktop's initializer, the brain's runtime and the companion's write
  // source start.
  api: ["lib/browser-companion/host-dispatch.ts", "lib/browser-companion/host-transport.ts"],
  // The agent-mode instruction a conversation started from the browser runs
  // with (ADR-0198 amendment).
  capabilityContributions: { load: () => import("./agent-grant") },
  // The agent-mode instruction and the browser-context preambles, for the
  // Prompt Center.
  prompts: () => import("./prompts"),
})
