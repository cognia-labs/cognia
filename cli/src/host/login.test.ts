import { loginHost } from "./login"

const CONFIG = { deploymentMode: "single-user", hostId: "host_1", tenantId: "tnt_1" }

function paired(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "https://h",
    deviceId: "dev_1",
    devicePrivateKeyJwk: { kty: "EC", d: "secret" },
    deviceKeyThumbprint: "thumb",
    serverVersion: "3",
    ...overrides,
  }
}

describe("loginHost", () => {
  it("reads the host and tenant ids from the public config", async () => {
    const seen: Array<Record<string, unknown>> = []
    const result = await loginHost({
      endpoint: "https://h/",
      invitation: "CODE",
      fetchConfig: async () => CONFIG as never,
      register: async (input) => {
        seen.push(input as Record<string, unknown>)
        return paired() as never
      },
    })
    expect(result.ok).toBe(true)
    expect(seen[0]).toMatchObject({
      baseUrl: "https://h",
      mode: "owner-invitation",
      invitation: "CODE",
      hostId: "host_1",
      tenantId: "tnt_1",
      displayName: "Cognia CLI",
    })
  })

  it("records a device host with the pinned fingerprint", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      serverFingerprint: "aa".repeat(32),
      fetchConfig: async () => CONFIG as never,
      register: async () => paired({ serverFingerprint: "bb".repeat(32) }) as never,
    })
    expect(result).toMatchObject({
      ok: true,
      record: { kind: "device", endpoint: "https://h", serverFingerprint: "bb".repeat(32) },
    })
  })

  it("keeps the CLI's own relay room, so commands can reach a relay-only host (ADR-0224 A4)", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => CONFIG as never,
      register: async () =>
        paired({
          rendezvousId: "room-9",
          signalingRoomDescriptor: { v: 2, roomId: "room-9" },
          signalingPrivateKeyJwk: { kty: "EC", d: "sig" },
          signalingUrl: "wss://relay.example/signaling",
        }) as never,
    })
    expect(result).toMatchObject({
      ok: true,
      record: {
        relay: {
          rendezvousId: "room-9",
          roomDescriptor: { roomId: "room-9" },
          signalingPrivateKeyJwk: { d: "sig" },
          signalingUrl: "wss://relay.example/signaling",
        },
      },
    })
  })

  it("records no relay room when an older host gave none", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => CONFIG as never,
      register: async () => paired() as never,
    })
    expect(result.ok && result.record.relay).toBeFalsy()
  })

  it("keeps the fingerprint the operator supplied when the host returns none", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      serverFingerprint: "cc".repeat(32),
      fetchConfig: async () => CONFIG as never,
      register: async () => paired({ serverFingerprint: undefined }) as never,
    })
    expect((result as { record: { serverFingerprint: string } }).record.serverFingerprint).toBe(
      "cc".repeat(32)
    )
  })

  it("honours an explicit tenant over the one the host advertises", async () => {
    const seen: Array<Record<string, unknown>> = []
    await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      tenantId: "chosen",
      fetchConfig: async () => CONFIG as never,
      register: async (input) => {
        seen.push(input as Record<string, unknown>)
        return paired() as never
      },
    })
    expect(seen[0].tenantId).toBe("chosen")
  })

  it("uses the label as the display name the owner will see", async () => {
    const seen: Array<Record<string, unknown>> = []
    await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      displayName: "build box",
      fetchConfig: async () => CONFIG as never,
      register: async (input) => {
        seen.push(input as Record<string, unknown>)
        return paired() as never
      },
    })
    expect(seen[0].displayName).toBe("build box")
  })

  it("refuses a multi-tenant host that announces no issuer to sign in with", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => ({ deploymentMode: "multi-tenant", hostId: "h" }) as never,
      register: async () => paired() as never,
    })
    expect(result).toMatchObject({
      ok: false,
      failure: { error: expect.stringContaining("announces no OIDC issuer") },
    })
  })

  it("needs a pairing code for a single-user host", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      fetchConfig: async () => CONFIG as never,
      register: async () => paired() as never,
    })
    expect(result).toMatchObject({
      ok: false,
      failure: { error: "https://h pairs with the owner's pairing code" },
    })
  })

  it("refuses when neither the host nor the operator names a tenant", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => ({ deploymentMode: "single-user", hostId: "h" }) as never,
      register: async () => paired() as never,
    })
    expect((result as { failure: { fix: string[] } }).failure.fix[0]).toContain("--tenant")
  })

  it("classifies an unreachable host as network and suggests the fingerprint", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => {
        throw new Error("self signed certificate")
      },
    })
    const failure = (result as { failure: { cause: string; fix: string[]; details: string[] } })
      .failure
    expect(failure.cause).toBe("network")
    expect(failure.details[0]).toContain("self signed certificate")
    expect(failure.fix.join(" ")).toContain("--fingerprint")
  })

  it("classifies a refused pairing as auth and says the code is single-use", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => CONFIG as never,
      register: async () => {
        throw new Error("invitation_consumed")
      },
    })
    const failure = (result as { failure: { cause: string; fix: string[] } }).failure
    expect(failure.cause).toBe("auth")
    expect(failure.fix[0]).toContain("single-use")
  })
})

describe("loginHost on a multi-tenant Host", () => {
  const MULTI = {
    deploymentMode: "multi-tenant",
    hostId: "host_m",
    configVersion: 6,
    oidc: {
      issuer: "https://id.example/oidc",
      audience: "https://api.example",
      webClientId: "web",
      nativeClientId: "native",
      scopes: ["openid"],
    },
    signaling: { url: "wss://s", iceServers: [] },
  }
  const session = (overrides: Record<string, unknown> = {}) =>
    ({
      issuer: "https://id.example/oidc/",
      clientId: "native",
      resource: "https://api.example",
      organizationId: "tnt_team",
      accessToken: "member-token",
      scopes: [],
      ...overrides,
    }) as never
  const account = (value: unknown) => ({
    id: "work",
    session: async () => value as never,
    describe: () => "Ann (usr_ann)",
  })

  it("registers the device as the account's person, with the tenant from their organization", async () => {
    const seen: Array<Record<string, unknown>> = []
    const result = await loginHost({
      endpoint: "https://team.example",
      account: account(session()),
      fetchConfig: async () => MULTI as never,
      register: async (input) => {
        seen.push(input as Record<string, unknown>)
        return paired() as never
      },
    })
    expect(seen[0]).toMatchObject({
      mode: "oidc",
      hostId: "host_m",
      tenantId: "tnt_team",
      oidc: {
        issuer: "https://id.example/oidc",
        resource: "https://api.example",
        clientId: "native",
        organizationId: "tnt_team",
        accessToken: "member-token",
      },
    })
    expect(seen[0]).not.toHaveProperty("invitation")
    expect(result).toMatchObject({
      ok: true,
      record: {
        kind: "device",
        tenantId: "tnt_team",
        deviceId: "dev_1",
        pairedAs: { account: "work", person: "Ann (usr_ann)" },
      },
    })
  })

  it("names the exact sign-in to run when the account is not signed in", async () => {
    const result = await loginHost({
      endpoint: "https://team.example",
      tenantId: "tnt_team",
      account: account(null),
      fetchConfig: async () => MULTI as never,
      register: async () => paired() as never,
    })
    expect(result).toMatchObject({ ok: false })
    expect((result as { failure: { fix: string[] } }).failure.fix[0]).toBe(
      "cognia-agent logto login --account work --issuer https://id.example/oidc --client-id native " +
        "--resource https://api.example --org tnt_team"
    )
  })

  it("asks for an account when none was given", async () => {
    const result = await loginHost({
      endpoint: "https://team.example",
      fetchConfig: async () => MULTI as never,
      register: async () => paired() as never,
    })
    expect((result as { failure: { fix: string[] } }).failure.fix[0]).toMatch(/--account <id>/)
  })

  it("refuses a session of another deployment before calling the Host", async () => {
    const register = jest.fn()
    for (const wrong of [
      { issuer: "https://id.cognia.cn/oidc" },
      { resource: "https://sync.cognia.cn" },
      { clientId: "someone-elses-app" },
    ]) {
      const result = await loginHost({
        endpoint: "https://team.example",
        account: account(session(wrong)),
        fetchConfig: async () => MULTI as never,
        register,
      })
      expect(result).toMatchObject({
        ok: false,
        failure: {
          error: expect.stringContaining("signs people in through https://id.example/oidc"),
        },
      })
    }
    expect(register).not.toHaveBeenCalled()
  })

  it("refuses a tenant the session's organization does not match, or no organization at all", async () => {
    const register = jest.fn()
    const mismatch = await loginHost({
      endpoint: "https://team.example",
      tenantId: "tnt_other",
      account: account(session()),
      fetchConfig: async () => MULTI as never,
      register,
    })
    expect(mismatch).toMatchObject({
      ok: false,
      failure: {
        error: "account work is signed in to organization tnt_team, not tenant tnt_other",
      },
    })
    const none = await loginHost({
      endpoint: "https://team.example",
      account: account(session({ organizationId: undefined })),
      fetchConfig: async () => MULTI as never,
      register,
    })
    expect((none as { failure: { error: string } }).failure.error).toMatch(
      /without an organization/
    )
    expect(register).not.toHaveBeenCalled()
  })

  it("reports an unreadable sign-in, and a Host that refuses the member", async () => {
    const unreadable = await loginHost({
      endpoint: "https://team.example",
      account: {
        id: "work",
        session: async () => {
          throw new Error("person.json is not a readable binding")
        },
        describe: () => "x",
      },
      fetchConfig: async () => MULTI as never,
      register: async () => paired() as never,
    })
    expect(unreadable).toMatchObject({
      ok: false,
      failure: { details: ["person.json is not a readable binding"] },
    })
    const refused = await loginHost({
      endpoint: "https://team.example",
      account: account(session()),
      fetchConfig: async () => MULTI as never,
      register: async () => {
        throw new Error("403 not a member")
      },
    })
    expect(refused).toMatchObject({
      ok: false,
      failure: {
        error: "https://team.example refused to register this device for Ann (usr_ann)",
        details: ["403 not a member"],
      },
    })
  })
})
