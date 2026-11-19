import { evaluateAutoDecision } from "../../lib/ai/agent/execution/permissions/auto-mode.ts"
import { __resetJudgeCache } from "../../lib/ai/agent/execution/permissions/command-judge.ts"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "../../lib/prompts/snapshot.ts"

async function main() {
  __setPromptOverrideSnapshotForTests(buildPromptOverrideSnapshot("audit-isolated-memory", []))
  const cases = [
    { safe: true, risk: "bogus", reason: "malformed enum" },
    { safe: true, reason: "missing enum" },
    { safe: true, risk: "high", reason: "valid high" },
    { safe: true, risk: "medium", reason: "valid medium" },
  ]
  for (const reply of cases) {
    __resetJudgeCache()
    let calls = 0
    const client = {
      complete: async () => {
        calls++
        return JSON.stringify(reply)
      },
    }
    const decision = await evaluateAutoDecision({
      command: "git push",
      config: { enabled: true, mode: "rules+model", denyOnHighRisk: true },
      client,
    })
    console.log(JSON.stringify({ reply, calls, decision }))
  }
}
void main()
