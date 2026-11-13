/** @jest-environment node */
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { declaredModuleTools } from "@/lib/modules/tool-declarations"
import { personalEgressToolDenied } from "@cognia/agent-contracts/personal-egress"

const ROOT = join(__dirname, "../..")
it("checks tool-entry gate dominance, including removal and branch regressions", () => {
  const script = join(ROOT, "docs/evidence/personal-egress-tool-entries.mjs")
  expect(
    execFileSync(process.execPath, [script, "--self-test"], { cwd: ROOT, encoding: "utf8" })
  ).toContain("regressions")
  expect(
    execFileSync(process.execPath, [script, "--mutation-check"], { cwd: ROOT, encoding: "utf8" })
  ).toContain("source mutations rejected")
  expect(
    execFileSync(process.execPath, [script, "--check"], { cwd: ROOT, encoding: "utf8" })
  ).toContain("dispatch sites pass")
})

it("denies every new opaque tool family and every non-read module by default", () => {
  for (const tool of declaredModuleTools().filter((tool) => tool.declaration.effect !== "read"))
    expect(personalEgressToolDenied(`mcp__cognia-plugin-tools__${tool.name}`, true)).toBe(true)
  for (const name of [
    "Bash",
    "WebFetch",
    "start_process",
    "shell_execute_advanced",
    "sandbox_bash",
    "code_interpreter",
    "browser_open",
    "browser_submit",
    "network_fetch",
    "mcp__new-server__read",
    "mcp__new-server__web_search",
  ])
    expect(personalEgressToolDenied(name, true)).toBe(true)
})

// Scan production sources, including untracked files, instead of just declarations.
it("G6: inventories direct network/process primitives and rejects new alias sites", () => {
  const script = join(ROOT, "docs/evidence/personal-egress-inventory.mjs")
  expect(
    execFileSync(process.execPath, [script, "--self-test"], { cwd: ROOT, encoding: "utf8" })
  ).toContain("regression")
  expect(
    execFileSync(process.execPath, [script, "--check"], { cwd: ROOT, encoding: "utf8" })
  ).toContain("no unclassified")
}, 60000)
