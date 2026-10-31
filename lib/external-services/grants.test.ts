import type {
  CapabilityGrant,
  ExternalCapability,
  ServiceConnection,
} from "@/types/external-service"

import {
  authorizeExternalCapability,
  extractCapabilityResourceScopes,
  grantCoversOperation,
} from "./grants"

const connection: ServiceConnection = {
  id: "connection-1",
  serviceId: "github",
  providerId: "api",
  runtimeTargetId: "desktop",
  status: "connected",
  providerFingerprint: "fingerprint-1",
  providerRef: { kind: "integration", accountId: "account-1" },
  enabledSurfaces: ["chat", "workflow"],
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
}

function capability(risk: ExternalCapability["risk"]): ExternalCapability {
  return {
    pluginId: "delivery",
    serviceId: "github",
    providerId: "api",
    capabilityId: "updateIssue",
    operationId: "issue.update",
    kind: "action",
    risk,
    scopeSelectors: [{ kind: "repository", jsonPointer: "/repository" }],
    surfaces: ["chat", "workflow"],
  }
}

function grant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: "grant-1",
    connectionId: connection.id,
    providerFingerprint: connection.providerFingerprint,
    operationPatterns: ["issue.*"],
    accountId: "account-1",
    resourceScopes: [{ kind: "repository", values: ["acme/app"] }],
    workflowId: "workflow-1",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  }
}

describe("external capability grants", () => {
  it.each(["read", "write", "destructive"] as const)(
    "requires a consumer and exact revision for connection-backed %s",
    (risk) => {
      const context = {
        interactive: false,
        consumerPluginId: "consumer",
        connectionRevision: 2,
      }
      const matching = grant({
        consumerPluginId: "consumer",
        connectionRevision: 2,
        accountId: undefined,
        workflowId: undefined,
        resourceScopes: undefined,
        allowDestructive: true,
      })
      for (const grants of [
        [],
        [{ ...matching, consumerPluginId: undefined }],
        [{ ...matching, consumerPluginId: "other" }],
        [{ ...matching, connectionRevision: undefined }],
        [{ ...matching, connectionRevision: 1 }],
        [{ ...matching, connectionRevision: 3 }],
      ]) {
        expect(
          authorizeExternalCapability({ capability: capability(risk), connection, grants, context })
        ).toEqual({ decision: "deny", reason: "grant-required" })
      }
      expect(
        authorizeExternalCapability({
          capability: capability(risk),
          connection,
          grants: [matching],
          context,
        })
      ).toEqual({ decision: "allow", reason: "scoped-grant", grantId: matching.id })
      expect(
        authorizeExternalCapability({
          capability: capability(risk),
          connection,
          grants: [],
          context: { ...context, interactive: true },
        })
      ).toEqual({ decision: "ask", reason: "consumer-grant-required" })
    }
  )
  it("allows trusted reads without a grant", () => {
    expect(
      authorizeExternalCapability({
        capability: capability("read"),
        connection,
        grants: [],
        context: { interactive: false },
      })
    ).toEqual({ decision: "allow", reason: "read-default" })
  })

  it("fails closed for an unknown headless capability", () => {
    expect(
      authorizeExternalCapability({
        connection,
        grants: [],
        context: { interactive: false },
      })
    ).toEqual({ decision: "deny", reason: "unknown-capability" })
  })

  it("keeps unknown, unavailable, mismatched and disabled-surface decisions", () => {
    const input = {
      capability: capability("read"),
      connection,
      grants: [],
      context: { interactive: true },
    }
    expect(authorizeExternalCapability({ ...input, capability: undefined })).toEqual({
      decision: "ask",
      reason: "unknown-capability",
    })
    expect(
      authorizeExternalCapability({ ...input, connection: { ...connection, status: "needs-auth" } })
    ).toEqual({ decision: "deny", reason: "connection-unavailable" })
    for (const changed of [{ serviceId: "other" }, { providerId: "other" }])
      expect(
        authorizeExternalCapability({ ...input, capability: { ...capability("read"), ...changed } })
      ).toEqual({ decision: "deny", reason: "connection-mismatch" })
    expect(
      authorizeExternalCapability({
        ...input,
        connection: { ...connection, enabledSurfaces: [] },
        context: { interactive: false, surface: "chat" },
      })
    ).toEqual({ decision: "deny", reason: "surface-disabled" })
    expect(authorizeExternalCapability({ ...input, capability: capability("write") })).toEqual({
      decision: "ask",
      reason: "write-confirmation",
    })
  })

  it("retains account/resource/surface restrictions for connection-backed reads", () => {
    const context = {
      interactive: false,
      consumerPluginId: "consumer",
      connectionRevision: 1,
      accountId: "account-1",
      workflowId: "workflow-1",
    }
    const matching = grant({ consumerPluginId: "consumer", connectionRevision: 1 })
    expect(
      authorizeExternalCapability({
        capability: capability("read"),
        connection,
        grants: [matching],
        context,
      })
    ).toEqual({ decision: "deny", reason: "grant-required" })
    expect(
      authorizeExternalCapability({
        capability: capability("read"),
        connection,
        grants: [matching],
        context: { ...context, resourceScopes: [{ kind: "repository", value: "other" }] },
      })
    ).toEqual({ decision: "deny", reason: "grant-required" })
    expect(
      authorizeExternalCapability({
        capability: capability("read"),
        connection,
        grants: [matching],
        context: { ...context, resourceScopes: [{ kind: "repository", value: "acme/app" }] },
      })
    ).toEqual({ decision: "allow", reason: "scoped-grant", grantId: "grant-1" })
  })

  it("lets an unscoped consumer grant cover every resource, but keeps legacy grants resource-bound", () => {
    const context = {
      interactive: false,
      consumerPluginId: "consumer",
      connectionRevision: 1,
      accountId: "account-1",
      workflowId: "workflow-1",
      resourceScopes: [{ kind: "repository", value: "any/repo" }],
    }
    const consumer = grant({
      consumerPluginId: "consumer",
      connectionRevision: 1,
      resourceScopes: undefined,
    })
    expect(
      authorizeExternalCapability({
        capability: capability("read"),
        connection,
        grants: [consumer],
        context,
      })
    ).toEqual({ decision: "allow", reason: "scoped-grant", grantId: "grant-1" })
    const { consumerPluginId: _consumer, connectionRevision: _revision, ...legacyContext } = context
    expect(
      authorizeExternalCapability({
        capability: capability("write"),
        connection,
        grants: [grant({ resourceScopes: undefined })],
        context: legacyContext,
      })
    ).toEqual({ decision: "deny", reason: "grant-required" })
  })

  it("allows a workflow write only with matching fingerprint, operation, account, and resource", () => {
    expect(
      authorizeExternalCapability({
        capability: capability("write"),
        connection,
        grants: [grant()],
        context: {
          interactive: false,
          accountId: "account-1",
          workflowId: "workflow-1",
          resourceScopes: [{ kind: "repository", value: "acme/app" }],
        },
      })
    ).toEqual({ decision: "allow", reason: "scoped-grant", grantId: "grant-1" })

    expect(
      authorizeExternalCapability({
        capability: capability("write"),
        connection,
        grants: [grant({ providerFingerprint: "old" })],
        context: {
          interactive: false,
          accountId: "account-1",
          workflowId: "workflow-1",
          resourceScopes: [{ kind: "repository", value: "acme/app" }],
        },
      })
    ).toEqual({ decision: "deny", reason: "grant-required" })
  })

  it("does not let a normal write grant authorize destructive behavior", () => {
    expect(
      authorizeExternalCapability({
        capability: capability("destructive"),
        connection,
        grants: [grant()],
        context: {
          interactive: true,
          accountId: "account-1",
          workflowId: "workflow-1",
          resourceScopes: [{ kind: "repository", value: "acme/app" }],
        },
      })
    ).toEqual({ decision: "ask", reason: "destructive-confirmation" })
  })

  it("extracts declared JSON pointer scopes and rejects absent values", () => {
    expect(
      extractCapabilityResourceScopes(capability("write"), { repository: "acme/app" })
    ).toEqual({ ok: true, scopes: [{ kind: "repository", value: "acme/app" }] })
    expect(extractCapabilityResourceScopes(capability("write"), {})).toEqual({
      ok: false,
      reason: 'Missing required resource scope "repository"',
    })
  })
})

describe("grantCoversOperation", () => {
  const context = { accountId: "account-1", workflowId: "workflow-1" }

  it("matches the operation, connection and binding, whatever the resource scopes", () => {
    expect(grantCoversOperation(grant(), capability("write"), connection, context)).toBe(true)
    expect(
      grantCoversOperation(
        grant({ resourceScopes: [{ kind: "repository", values: ["other/repo"] }] }),
        capability("write"),
        connection,
        context
      )
    ).toBe(true)
  })

  it("matches explicit consumer/revision bindings and exact, wildcard or capability-only operations", () => {
    const candidate = grant({
      consumerPluginId: "consumer",
      connectionRevision: 2,
      operationPatterns: ["*"],
    })
    expect(
      grantCoversOperation(candidate, capability("write"), connection, {
        ...context,
        consumerPluginId: "consumer",
        connectionRevision: 2,
      })
    ).toBe(true)
    expect(
      grantCoversOperation(candidate, capability("write"), connection, {
        ...context,
        consumerPluginId: "consumer",
        connectionRevision: 3,
      })
    ).toBe(false)
    expect(
      grantCoversOperation(candidate, capability("write"), connection, {
        ...context,
        consumerPluginId: "other",
        connectionRevision: 2,
      })
    ).toBe(false)
    expect(
      grantCoversOperation(
        grant({ operationPatterns: ["updateIssue"] }),
        { ...capability("write"), operationId: undefined },
        connection,
        context
      )
    ).toBe(true)
    expect(
      grantCoversOperation(grant(), capability("write"), { ...connection, id: "other" }, context)
    ).toBe(false)
    expect(
      grantCoversOperation(
        grant({ operationPatterns: ["issue.*.bad"] }),
        capability("write"),
        connection,
        context
      )
    ).toBe(false)
  })

  it.each([
    ["another consumer", grant({ consumerPluginId: "consumer" }), context],
    ["another revision", grant({ connectionRevision: 2 }), context],
    ["another operation", grant({ operationPatterns: ["pull.*"] }), context],
    ["another account", grant(), { ...context, accountId: "account-2" }],
    ["another workflow", grant(), { accountId: "account-1" }],
    ["another session", grant({ sessionId: "s1" }), context],
    ["an expired grant", grant({ expiresAt: "2000-01-01T00:00:00.000Z" }), context],
    ["another fingerprint", grant({ providerFingerprint: "fingerprint-2" }), context],
  ])("does not match %s", (_label, candidate, candidateContext) => {
    expect(grantCoversOperation(candidate, capability("write"), connection, candidateContext)).toBe(
      false
    )
  })

  it("needs allowDestructive for a destructive operation", () => {
    expect(grantCoversOperation(grant(), capability("destructive"), connection, context)).toBe(
      false
    )
    expect(
      grantCoversOperation(
        grant({ allowDestructive: true }),
        capability("destructive"),
        connection,
        context
      )
    ).toBe(true)
  })
})
