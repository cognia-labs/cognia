import { test } from "node:test"
import assert from "node:assert/strict"

import {
  CLAUDE_TOOL_NAME_BY_COGNIA_BARE,
  passesAllowList,
  passesToolLists,
  toolNameCandidates,
} from "./allow-list.ts"

test("an absent or empty whitelist admits every tool", () => {
  assert.equal(passesAllowList(null, ["read"]), true)
  assert.equal(passesAllowList(undefined, ["read"]), true)
  assert.equal(passesAllowList(new Set(), ["read"]), true)
})

test("a whitelist admits a tool when any candidate name matches", () => {
  const allow = new Set(["Read", "mcp__cognia-tools__grep"])
  assert.equal(passesAllowList(allow, ["read", "mcp__cognia-tools__read", "Read"]), true)
  assert.equal(passesAllowList(allow, ["grep", "mcp__cognia-tools__grep"]), true)
  assert.equal(passesAllowList(allow, ["bash", "mcp__cognia-tools__bash", "Bash"]), false)
})

test("core file tools map to their Claude Code names; the table is frozen", () => {
  assert.equal(CLAUDE_TOOL_NAME_BY_COGNIA_BARE.read, "Read")
  assert.equal(CLAUDE_TOOL_NAME_BY_COGNIA_BARE.multi_edit, "MultiEdit")
  assert.equal(CLAUDE_TOOL_NAME_BY_COGNIA_BARE.git_status, undefined)
  assert.ok(Object.isFrozen(CLAUDE_TOOL_NAME_BY_COGNIA_BARE))
})

test("every Claude alias shares one allow/deny candidate set", () => {
  for (const [bare, alias] of Object.entries(CLAUDE_TOOL_NAME_BY_COGNIA_BARE)) {
    const candidates = [bare, `mcp__cognia-tools__${bare}`, alias]
    assert.deepEqual(toolNameCandidates(bare, "cognia-tools"), candidates)
    for (const candidate of candidates) {
      assert.equal(passesToolLists(bare, "cognia-tools", new Set([candidate]), new Set()), true)
      assert.equal(
        passesToolLists(bare, "cognia-tools", new Set(candidates), new Set([candidate])),
        false
      )
    }
  }
  for (const server of ["cognia-plugin-tools", "external"]) {
    assert.deepEqual(toolNameCandidates("read", server), ["read", `mcp__${server}__read`])
    for (const candidate of toolNameCandidates("read", server)) {
      assert.equal(
        passesToolLists("read", server, new Set([candidate]), new Set([candidate])),
        false
      )
    }
  }
})
