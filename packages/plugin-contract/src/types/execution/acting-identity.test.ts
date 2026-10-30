import { AUTHORITY_RANK } from "@cognia/agent-config-types/agent-composition"
import { PERMISSION_CLASSES } from "@cognia/agent-config-types/unattended-permission"
import {
  absorbRequester,
  checkActingAuthority,
  meetRunAuthority,
  type ActingIdentityV1,
  type PrincipalRefV1,
  type RunAuthorityV1,
} from "./acting-identity"

const identity: ActingIdentityV1 = {
  schemaVersion: 1,
  rootRunId: "identity-root",
  lane: "legacy",
  trigger: "requester",
  actingPrincipal: { kind: "service", ref: "app" },
  authorizingPrincipal: { kind: "local-person", accountId: "owner" },
  bindingId: "binding",
  requesters: [],
  authorityRevision: 0,
}

describe("acting identity", () => {
  const principals: PrincipalRefV1[] = [
    { kind: "local-person" },
    { kind: "local-person", userId: "u", accountId: "a" },
    { kind: "platform", platform: "feishu", adapterId: "a", remoteUserId: "u" },
    { kind: "service", ref: "service" },
  ]
  it("never promotes an event actor into a requester", () => {
    expect(
      absorbRequester(identity, { kind: "event-actor", source: "github", externalId: "actor" })
    ).toBe(identity)
  })
  it.each(principals)(
    "absorbs and deduplicates $kind without changing fixed fields",
    (principal) => {
      const next = absorbRequester(identity, principal)
      expect(next).not.toBe(identity)
      expect(next).toEqual({ ...identity, requesters: [principal], authorityRevision: 1 })
      expect(identity.requesters).toEqual([])
      expect(absorbRequester(next, { ...principal })).toBe(next)
    }
  )
  it("uses transport identity as the stable platform key, independent of enrichment", () => {
    const sender: PrincipalRefV1 = {
      kind: "platform",
      platform: "feishu",
      adapterId: "a",
      remoteUserId: "u",
    }
    const first = absorbRequester(identity, sender)
    expect(absorbRequester(first, { ...sender, principalId: "p", unionId: "union" })).toBe(first)
    const next = absorbRequester(first, { ...sender, adapterId: "b" })
    expect(next.authorityRevision).toBe(2)
    expect(next.requesters).toHaveLength(2)
  })
  it("keeps delimiter-containing ids distinct", () => {
    const first = absorbRequester(identity, { kind: "local-person", userId: "a:b", accountId: "c" })
    expect(
      absorbRequester(first, { kind: "local-person", userId: "a", accountId: "b:c" }).requesters
    ).toHaveLength(2)
  })
  it("checks missing and advanced revisions without enforcing anything", () => {
    expect(checkActingAuthority(undefined, 0)).toEqual({ ok: false, reason: "missing" })
    expect(checkActingAuthority(identity, 0)).toEqual({ ok: true })
    expect(checkActingAuthority({ ...identity, authorityRevision: 1 }, 0)).toEqual({
      ok: false,
      reason: "revision_advanced",
    })
    expect(checkActingAuthority(identity, 1)).toEqual({ ok: true })
  })
})

describe("meetRunAuthority", () => {
  const empty: RunAuthorityV1 = { schemaVersion: 1 }
  it("meets every field and carries the parent's pool by reference", () => {
    const parent: RunAuthorityV1 = {
      schemaVersion: 1,
      permissionMode: "default",
      tools: { allow: ["a", "b"], deny: ["x"] },
      skills: { only: ["a", "b"] },
      mcpServers: { only: ["a", "b"] },
      subagents: { only: ["a", "b"] },
      permissionProfile: { workspace: "ask", secrets: "ask" },
      maxTurns: 3,
      pools: { rootRunId: "root", tokenBudget: 100, costUsd: 2, deadlineMs: 999 },
    }
    const child: RunAuthorityV1 = {
      schemaVersion: 1,
      permissionMode: "bypassPermissions",
      tools: { allow: ["b", "c"], deny: ["y"] },
      skills: { only: ["b", "c"] },
      mcpServers: { only: ["b", "c"] },
      subagents: { only: ["b", "c"] },
      permissionProfile: { workspace: "sandbox", secrets: "deny", outbound: "deny" },
      maxTurns: 9,
      pools: { rootRunId: "child", tokenBudget: 999 },
    }
    expect(meetRunAuthority(parent, child)).toEqual({
      ...parent,
      tools: { allow: ["b"], deny: ["x", "y"] },
      skills: { only: ["b"] },
      mcpServers: { only: ["b"] },
      subagents: { only: ["b"] },
      permissionProfile: { workspace: "ask", secrets: "deny", outbound: "deny" },
    })
    expect(meetRunAuthority(parent, child).pools).toBe(parent.pools)
    expect(meetRunAuthority(empty, child).pools).toBeUndefined()
  })
  it.each(["tools", "skills", "mcpServers", "subagents"] as const)(
    "treats undefined as unrestricted and empty %s as none",
    (field) => {
      const key = field === "tools" ? "allow" : "only"
      const none = { ...empty, [field]: { [key]: [] } }
      const one = { ...empty, [field]: { [key]: ["a"] } }
      expect(meetRunAuthority(empty, none)[field]).toEqual({ [key]: [] })
      expect(meetRunAuthority(none, one)[field]).toEqual({ [key]: [] })
      expect(meetRunAuthority(empty, one)[field]).toEqual({ [key]: ["a"] })
    }
  )
  it("is idempotent, commutative outside pools, and never widens either input", () => {
    const authorities: RunAuthorityV1[] = [empty]
    for (const permissionMode of Object.keys(AUTHORITY_RANK) as Array<
      keyof typeof AUTHORITY_RANK
    >) {
      for (const allow of [undefined, [], ["a"], ["a", "b"]]) {
        authorities.push({
          schemaVersion: 1,
          permissionMode,
          tools: { allow, deny: ["x"] },
          skills: { only: allow },
          mcpServers: { only: allow },
          subagents: { only: allow },
          permissionProfile: { workspace: permissionMode === "plan" ? "deny" : "sandbox" },
          maxTurns: AUTHORITY_RANK[permissionMode] + 1,
        })
      }
    }
    for (const a of authorities) {
      expect(meetRunAuthority(a, a)).toEqual(a)
      for (const b of authorities) {
        const result = meetRunAuthority(a, b)
        expect(result).toEqual(meetRunAuthority(b, a))
        for (const bound of [a, b]) {
          if (bound.permissionMode)
            expect(AUTHORITY_RANK[result.permissionMode!]).toBeLessThanOrEqual(
              AUTHORITY_RANK[bound.permissionMode]
            )
          if (bound.maxTurns !== undefined)
            expect(result.maxTurns).toBeLessThanOrEqual(bound.maxTurns)
          for (const field of ["skills", "mcpServers", "subagents"] as const) {
            if (bound[field]?.only)
              expect(result[field]!.only!.every((id) => bound[field]!.only!.includes(id))).toBe(
                true
              )
          }
          if (bound.tools?.allow)
            expect(result.tools!.allow!.every((id) => bound.tools!.allow!.includes(id))).toBe(true)
          expect(bound.tools?.deny?.every((id) => result.tools!.deny!.includes(id)) ?? true).toBe(
            true
          )
        }
      }
    }
  })
  it("uses the existing strict ordering for every profile class", () => {
    for (const cls of PERMISSION_CLASSES) {
      const levels =
        cls === "workspace" ? (["deny", "ask", "sandbox"] as const) : (["deny", "ask"] as const)
      for (let a = 0; a < levels.length; a++)
        for (let b = 0; b < levels.length; b++) {
          expect(
            meetRunAuthority(
              { ...empty, permissionProfile: { [cls]: levels[a] } },
              { ...empty, permissionProfile: { [cls]: levels[b] } }
            ).permissionProfile
          ).toEqual({ [cls]: levels[Math.min(a, b)] })
        }
    }
  })
  it("treats list ordering and duplicate entries as set semantics", () => {
    const a: RunAuthorityV1 = {
      schemaVersion: 1,
      tools: { allow: ["b", "a", "a"], deny: ["y", "x"] },
      skills: { only: ["b", "a"] },
    }
    const b: RunAuthorityV1 = {
      schemaVersion: 1,
      tools: { allow: ["a", "b"], deny: ["x", "z"] },
      skills: { only: ["a", "b"] },
    }
    expect(meetRunAuthority(a, b)).toEqual(meetRunAuthority(b, a))
    expect(meetRunAuthority(a, a)).toEqual(a)
    const once = meetRunAuthority(a, a)
    expect(meetRunAuthority(once, once)).toEqual(once)
  })
})
