import path from "node:path"

import { parseArgv } from "./args"
import { EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "./errors"
import { hostCommand, HOST_HELP, relayLoginNote, type HostCommandDeps } from "./host-command"
import type { OutputSink } from "./output"
import { parseHostsFile, type HostsFs } from "../host/store"

const HOME = "/home/.cognia"
const CWD = "/repo"
const USER_FILE = `${HOME}/hosts.json`
const PROJECT_FILE = `${CWD}/.cognia/hosts.json`

function sink(): OutputSink & { stdout: string; stderr: string[] } {
  const captured = {
    stdout: "",
    stderr: [] as string[],
    write(text: string) {
      captured.stdout += text
    },
    error(text: string) {
      captured.stderr.push(text)
    },
    json(value: unknown) {
      captured.stdout += `${JSON.stringify(value)}\n`
    },
  }
  return captured
}

function memoryFs(): HostsFs & { files: Map<string, string>; modes: Map<string, number> } {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  return {
    files,
    modes,
    read: (target) => files.get(target) ?? null,
    write: (target, content, mode) => {
      files.set(target, content)
      modes.set(target, mode)
    },
    mkdirp: () => undefined,
    dirname: (target) => target.split("/").slice(0, -1).join("/"),
  }
}

function deps(extra: Partial<HostCommandDeps> = {}): HostCommandDeps & {
  out: ReturnType<typeof sink>
  fs: ReturnType<typeof memoryFs>
} {
  const out = sink()
  const fs = memoryFs()
  return { out, fs, env: {}, home: HOME, cwd: CWD, ...extra } as never
}

function run(argv: string[], commandDeps: HostCommandDeps): Promise<number> {
  return hostCommand(parseArgv(argv), commandDeps)
}

describe("help and paths", () => {
  it("prints help and exits 2 with no subcommand", async () => {
    const d = deps()
    expect(await run(["host"], d)).toBe(EXIT_USAGE)
    expect(d.out.stdout).toBe(HOST_HELP)
  })

  it("names both files and which one a write would land in", async () => {
    const d = deps()
    await run(["host", "path", "--format", "raw"], d)
    expect(JSON.parse(d.out.stdout)).toEqual({
      user: USER_FILE,
      project: PROJECT_FILE,
      writing: USER_FILE,
    })
  })

  it("points at the project file under --local", async () => {
    const d = deps()
    await run(["host", "path", "--local", "--format", "raw"], d)
    expect(JSON.parse(d.out.stdout).writing).toBe(PROJECT_FILE)
  })
})

describe("host add", () => {
  it("writes a host and makes the first one active", async () => {
    const d = deps()
    expect(await run(["host", "add", "local", "--endpoint", "https://127.0.0.1:27890/"], d)).toBe(
      EXIT_OK
    )
    const stored = parseHostsFile(d.fs.files.get(USER_FILE)!)
    expect(stored.active).toBe("local")
    expect(stored.hosts.local).toEqual({ kind: "headless", endpoint: "https://127.0.0.1:27890" })
  })

  it("stores the token but never prints it back", async () => {
    const d = deps()
    await run(
      [
        "host",
        "add",
        "local",
        "--endpoint",
        "https://h",
        "--token",
        "super-secret",
        "--format",
        "raw",
      ],
      d
    )
    expect(parseHostsFile(d.fs.files.get(USER_FILE)!).hosts.local.serviceToken).toBe("super-secret")
    expect(d.out.stdout).toContain('"serviceToken":"(set)"')
    expect(d.out.stdout).not.toContain("super-secret")
  })

  it("writes owner-only permissions", async () => {
    const d = deps()
    await run(["host", "add", "local", "--endpoint", "https://h"], d)
    expect(d.fs.modes.get(USER_FILE)).toBe(0o600)
  })

  it("needs a name and an endpoint", async () => {
    const d = deps()
    expect(await run(["host", "add", "local"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("--endpoint")
  })

  it("refuses an unknown kind", async () => {
    const d = deps()
    expect(await run(["host", "add", "x", "--endpoint", "https://h", "--kind", "pigeon"], d)).toBe(
      EXIT_USAGE
    )
    expect(d.out.stderr[0]).toContain("headless or device")
  })

  it("activates the new host under --use", async () => {
    const d = deps()
    await run(["host", "add", "a", "--endpoint", "https://a"], d)
    await run(["host", "add", "b", "--endpoint", "https://b", "--use"], d)
    expect(parseHostsFile(d.fs.files.get(USER_FILE)!).active).toBe("b")
  })

  it("writes to the project file under --local", async () => {
    const d = deps()
    await run(["host", "add", "staging", "--endpoint", "https://s", "--local"], d)
    expect(d.fs.files.has(PROJECT_FILE)).toBe(true)
    expect(d.fs.files.has(USER_FILE)).toBe(false)
  })
})

describe("host list, use and remove", () => {
  it("lists hosts with the active one marked and secrets redacted", async () => {
    const d = deps()
    await run(["host", "add", "a", "--endpoint", "https://a", "--token", "t"], d)
    await run(["host", "add", "b", "--endpoint", "https://b"], d)
    d.out.stdout = ""
    await run(["host", "list", "--format", "raw"], d)
    const rows = JSON.parse(d.out.stdout) as Array<Record<string, string>>
    expect(rows.map((row) => row.name)).toEqual(["a", "b"])
    expect(rows[0].active).toBe("yes")
    expect(rows[0].serviceToken).toBe("(set)")
    expect(d.out.stdout).not.toContain('"t"')
  })

  it("switches the active host", async () => {
    const d = deps()
    await run(["host", "add", "a", "--endpoint", "https://a"], d)
    await run(["host", "add", "b", "--endpoint", "https://b"], d)
    expect(await run(["host", "use", "b"], d)).toBe(EXIT_OK)
    expect(parseHostsFile(d.fs.files.get(USER_FILE)!).active).toBe("b")
  })

  it("refuses to use a host that does not exist", async () => {
    const d = deps()
    expect(await run(["host", "use", "ghost"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("ghost")
  })

  it("removes a host and reports the survivor", async () => {
    const d = deps()
    await run(["host", "add", "a", "--endpoint", "https://a"], d)
    await run(["host", "add", "b", "--endpoint", "https://b"], d)
    d.out.stdout = ""
    await run(["host", "remove", "a", "--format", "raw"], d)
    expect(JSON.parse(d.out.stdout)).toMatchObject({ removed: "a", active: "b" })
  })
})

describe("host show", () => {
  it("reports the source of every resolved value", async () => {
    const d = deps()
    await run(["host", "add", "local", "--endpoint", "https://h", "--token", "t"], d)
    d.out.stdout = ""
    await run(["host", "show", "--format", "raw"], d)
    const rows = JSON.parse(d.out.stdout) as Array<Record<string, string>>
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]))
    expect(byKey.endpoint.source).toBe("user-file")
    expect(byKey.serviceToken.value).toBe("(set)")
  })

  it("shows the environment winning over the saved value", async () => {
    const d = deps({ env: { COGNIA_SERVICE_TOKEN: "env-token" } })
    await run(["host", "add", "local", "--endpoint", "https://h", "--token", "saved"], d)
    d.out.stdout = ""
    await run(["host", "show", "--format", "raw"], d)
    const rows = JSON.parse(d.out.stdout) as Array<Record<string, string>>
    const token = rows.find((row) => row.key === "serviceToken")!
    expect(token.source).toBe("env")
    expect(token.origin).toBe("COGNIA_SERVICE_TOKEN")
  })

  it("explains what it tried when nothing resolves", async () => {
    const d = deps()
    expect(await run(["host", "show"], d)).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("Cause: no-host")
    expect(d.out.stderr[0]).toContain("Fix: cognia-agent host add")
  })
})

describe("host login", () => {
  it("saves the paired device identity and keeps the key out of stdout", async () => {
    const d = deps({
      login: {
        fetchConfig: async () =>
          ({ deploymentMode: "single-user", hostId: "host_1", tenantId: "tnt_1" }) as never,
        register: async () =>
          ({
            baseUrl: "https://h",
            deviceId: "dev_9",
            devicePrivateKeyJwk: { kty: "EC", d: "PRIVATE" },
            deviceKeyThumbprint: "thumb",
            serverVersion: "1",
          }) as never,
      },
    })
    expect(
      await run(
        [
          "host",
          "login",
          "desktop",
          "--endpoint",
          "https://h",
          "--pair-code",
          "ABC",
          "--format",
          "raw",
        ],
        d
      )
    ).toBe(EXIT_OK)
    const stored = parseHostsFile(d.fs.files.get(USER_FILE)!)
    expect(stored.hosts.desktop).toMatchObject({
      kind: "device",
      deviceId: "dev_9",
      tenantId: "tnt_1",
    })
    expect(stored.hosts.desktop.devicePrivateKeyJwk).toEqual({ kty: "EC", d: "PRIVATE" })
    expect(d.out.stdout).toContain('"devicePrivateKey":"(set)"')
    expect(d.out.stdout).not.toContain("PRIVATE")
  })

  it("pairs from a cgnp4 invitation alone, and says when it had to use the relay", async () => {
    const { encodePairPayload } = await import("@/lib/qr/pair-payload")
    const invitation = encodePairPayload({
      baseUrl: "https://127.0.0.1:27890",
      mode: "owner-invitation",
      invitation: "owner-invitation",
      hostId: "host_1",
      tenantId: "tnt_1",
      expiresAt: Date.now() + 60_000,
      serverVersion: "1",
      fingerprint: "ab".repeat(32),
      relay: {
        url: "wss://relay.example/signaling",
        room: {
          v: 2,
          roomId: "room-1",
          roomNonce: "n",
          desktopSigningKey: "d",
          mobileSigningKey: "m",
          notAfter: Date.now() + 60_000,
        },
        mobilePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "d", x: "x", y: "y" },
      },
    })
    const close = jest.fn()
    const d = deps({
      fetcher: jest.fn(),
      invitationLogin: {
        probeDirect: async () => false,
        createRelayFetcher: async () => ({ fetcher: jest.fn(), close }),
        login: {
          fetchConfig: async () =>
            ({ deploymentMode: "single-user", hostId: "host_1", tenantId: "tnt_1" }) as never,
          register: async () =>
            ({
              baseUrl: "https://127.0.0.1:27890",
              deviceId: "dev_9",
              devicePrivateKeyJwk: { kty: "EC", d: "PRIVATE" },
              serverVersion: "1",
              // The CLI's own relay room (ADR-0224 A4), separate from the
              // one-shot pairing room the invitation carried.
              rendezvousId: "dev-room",
              signalingRoomDescriptor: { v: 2, roomId: "dev-room", mobileSigningKey: "m" },
              signalingPrivateKeyJwk: { kty: "EC", d: "SIGNALSECRET" },
              signalingUrl: "wss://relay.example/signaling",
            }) as never,
        },
      },
    })
    expect(
      await run(["host", "login", "home", "--invitation", invitation, "--format", "raw"], d)
    ).toBe(EXIT_OK)
    const stored = parseHostsFile(d.fs.files.get(USER_FILE)!)
    expect(stored.hosts.home).toMatchObject({
      kind: "device",
      endpoint: "https://127.0.0.1:27890",
      deviceId: "dev_9",
      tenantId: "tnt_1",
      serverFingerprint: "ab".repeat(32),
    })
    expect(stored.hosts.home?.relay).toEqual({
      rendezvousId: "dev-room",
      roomDescriptor: { v: 2, roomId: "dev-room", mobileSigningKey: "m" },
      signalingPrivateKeyJwk: { kty: "EC", d: "SIGNALSECRET" },
      signalingUrl: "wss://relay.example/signaling",
    })
    expect(d.out.stdout).toContain('"path":"relay"')
    expect(d.out.stdout).toContain("this CLI's relay room")
    expect(d.out.stdout).toContain('"signalingPrivateKey":"(set)"')
    expect(d.out.stdout).not.toContain("PRIVATE")
    expect(d.out.stdout).not.toContain("SIGNALSECRET")
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("says plainly when an older host gave the CLI no relay room", () => {
    expect(relayLoginNote("https://h:1", false)).toContain("gave the CLI no relay room")
    expect(relayLoginNote("https://h:1", true)).toContain("relay room on the host")
  })

  it("hands the pinned direct fetcher to a pairing-code login", async () => {
    const fetcher = jest.fn()
    const used: unknown[] = []
    const d = deps({
      fetcher,
      login: {
        fetchConfig: async (_url, _fp, given) => {
          used.push(given)
          return { deploymentMode: "single-user", hostId: "h", tenantId: "t" } as never
        },
        register: async (_input, given) => {
          used.push(given)
          return { baseUrl: "https://h", deviceId: "d", serverVersion: "1" } as never
        },
      },
    })
    expect(
      await run(["host", "login", "desktop", "--endpoint", "https://h", "--pair-code", "X"], d)
    ).toBe(EXIT_OK)
    expect(used).toEqual([fetcher, fetcher])
  })

  it("needs a name and an endpoint, and a single-user host a pairing code", async () => {
    const d = deps()
    expect(await run(["host", "login", "desktop"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("--pair-code")
    const single = deps({
      login: {
        fetchConfig: async () =>
          ({ deploymentMode: "single-user", hostId: "h", tenantId: "t" }) as never,
      },
    })
    expect(await run(["host", "login", "desktop", "--endpoint", "https://h"], single)).toBe(
      EXIT_FAILURE
    )
    expect(single.out.stderr[0]).toContain("pairs with the owner's pairing code")
  })

  describe("a multi-tenant host", () => {
    const MULTI = {
      deploymentMode: "multi-tenant",
      hostId: "host_m",
      oidc: {
        issuer: "https://id.example/oidc",
        audience: "https://api.example",
        webClientId: "web",
        nativeClientId: "native",
        scopes: [],
      },
      signaling: { url: "wss://s", iceServers: [] },
    }
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    const accessToken = `h.${b64({ sub: "usr_ann", organization_id: "tnt_team" })}.s`
    const accountDir = path.join(HOME, "accounts", "work")
    const signedIn = (person = "usr_ann") => {
      const files = new Map<string, string>([
        [
          path.join(accountDir, "logto.json"),
          JSON.stringify({
            issuer: "https://id.example/oidc",
            clientId: "native",
            resource: "https://api.example",
            organizationId: "tnt_team",
            accessToken,
            idToken: `h.${b64({ name: "Ann" })}.s`,
            scopes: [],
          }),
        ],
        [
          path.join(accountDir, "person.json"),
          JSON.stringify({ issuer: "https://id.example/oidc", subject: person, boundAt: 1 }),
        ],
      ])
      return {
        read: (file: string) => files.get(file) ?? null,
        write: () => undefined,
        remove: () => undefined,
        mkdirp: () => undefined,
        listDirs: () => [],
      }
    }

    it("registers the device as the signed-in account's person and records who paired", async () => {
      const seen: Array<Record<string, unknown>> = []
      const d = deps({
        sessionFs: signedIn(),
        login: {
          fetchConfig: async () => MULTI as never,
          register: async (input) => {
            seen.push(input as Record<string, unknown>)
            return { baseUrl: "https://team", deviceId: "dev_m", serverVersion: "6" } as never
          },
        },
      })
      expect(
        await run(
          [
            "host",
            "login",
            "team",
            "--endpoint",
            "https://team",
            "--account",
            "work",
            "--format",
            "raw",
          ],
          d
        )
      ).toBe(EXIT_OK)
      expect(seen[0]).toMatchObject({
        mode: "oidc",
        tenantId: "tnt_team",
        oidc: { accessToken, clientId: "native" },
      })
      expect(JSON.parse(d.out.stdout)).toMatchObject({
        paired: "team",
        kind: "device",
        tenantId: "tnt_team",
        pairedAs: { account: "work", person: "Ann (usr_ann)" },
      })
      expect(d.out.stdout).not.toContain(accessToken)
    })

    it("never pairs with a session that no longer signs in as the account's person", async () => {
      const register = jest.fn()
      const d = deps({
        sessionFs: signedIn("usr_bob"),
        login: { fetchConfig: async () => MULTI as never, register },
      })
      expect(
        await run(["host", "login", "team", "--endpoint", "https://team", "--account", "work"], d)
      ).toBe(EXIT_FAILURE)
      expect(register).not.toHaveBeenCalled()
      expect(d.out.stderr[0]).toContain("account work is not signed in")
      expect(d.out.stderr[0]).toContain(
        "cognia-agent logto login --account work --issuer https://id.example/oidc --client-id native"
      )
    })

    it("refuses --account without a value", async () => {
      const d = deps()
      expect(
        await run(["host", "login", "team", "--endpoint", "https://team", "--account"], d)
      ).toBe(EXIT_USAGE)
      expect(d.out.stderr[0]).toContain("--account")
    })
  })

  it("says a pairing code is single-use when the host refuses", async () => {
    const d = deps({
      login: {
        fetchConfig: async () =>
          ({ deploymentMode: "single-user", hostId: "h", tenantId: "t" }) as never,
        register: async () => {
          throw new Error("invitation_consumed")
        },
      },
    })
    expect(
      await run(["host", "login", "desktop", "--endpoint", "https://h", "--pair-code", "X"], d)
    ).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("single-use")
    expect(d.out.stderr[0]).toContain("invitation_consumed")
  })

  it("reports an unreachable host with the fingerprint hint", async () => {
    const d = deps({
      login: {
        fetchConfig: async () => {
          throw new Error("self signed certificate")
        },
      },
    })
    expect(
      await run(["host", "login", "desktop", "--endpoint", "https://h", "--pair-code", "X"], d)
    ).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("--fingerprint")
  })
})

describe("host selection, credentials and revocation (audit 13–17)", () => {
  const PAIRED = {
    kind: "device" as const,
    endpoint: "https://prod",
    tenantId: "tnt_1",
    deviceId: "dev_old",
    devicePrivateKeyJwk: { kty: "EC", d: "OLD" },
  }
  const seed = (d: ReturnType<typeof deps>, target: string, file: object) =>
    d.fs.files.set(target, JSON.stringify(file))
  const pairingLogin = {
    fetchConfig: async () =>
      ({ deploymentMode: "single-user", hostId: "host_1", tenantId: "tnt_1" }) as never,
    register: async () =>
      ({
        baseUrl: "https://prod",
        deviceId: "dev_new",
        devicePrivateKeyJwk: { kty: "EC", d: "NEW" },
        deviceKeyThumbprint: "thumb",
        serverVersion: "1",
      }) as never,
  }
  const loginArgs = ["host", "login", "prod", "--endpoint", "https://prod", "--pair-code", "ABC"]

  it("refuses a host-selecting flag given without a value", async () => {
    const d = deps()
    expect(await run(["host", "show", "--host"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr.join("")).toContain("--host needs a value")
    expect(await run(["host", "add", "x", "--endpoint", "https://h", "--token"], d)).toBe(
      EXIT_USAGE
    )
    expect(d.fs.files.has(USER_FILE)).toBe(false)
  })

  it("host use fails instead of reporting a choice the project file overrides", async () => {
    const d = deps()
    seed(d, USER_FILE, {
      version: 1,
      active: "a",
      hosts: {
        a: { kind: "headless", endpoint: "https://a" },
        b: { kind: "headless", endpoint: "https://b" },
      },
    })
    seed(d, PROJECT_FILE, {
      version: 1,
      active: "a",
      hosts: { a: { kind: "headless", endpoint: "https://pa" } },
    })
    expect(await run(["host", "use", "b"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr.join("")).toContain("--local")
    expect(parseHostsFile(d.fs.files.get(USER_FILE)!).active).toBe("a")
  })

  it("host use says when the project's record of that name is the one used", async () => {
    const d = deps()
    seed(d, USER_FILE, {
      version: 1,
      active: "b",
      hosts: {
        a: { kind: "headless", endpoint: "https://a" },
        b: { kind: "headless", endpoint: "https://b" },
      },
    })
    seed(d, PROJECT_FILE, {
      version: 1,
      hosts: { a: { kind: "headless", endpoint: "https://pa" } },
    })
    expect(await run(["host", "use", "a", "--format", "raw"], d)).toBe(EXIT_OK)
    const result = JSON.parse(d.out.stdout)
    expect(result.record).toBe(PROJECT_FILE)
    expect(result.note).toContain("its record is the one used")
  })

  it("keeps a project hosts file holding a credential out of Git, once", async () => {
    const d = deps()
    const ignore = `${CWD}/.cognia/.gitignore`
    await run(["host", "add", "plain", "--endpoint", "https://p", "--local"], d)
    expect(d.fs.files.has(ignore)).toBe(false)
    d.out.stdout = ""
    await run(
      ["host", "add", "s", "--endpoint", "https://s", "--token", "t", "--local", "--format", "raw"],
      d
    )
    expect(d.fs.files.get(ignore)).toMatch(/^# Written by cognia-agent.*\nhosts\.json\n$/)
    expect(JSON.parse(d.out.stdout).gitignore).toBe(".cognia/.gitignore")
    await run(["host", "add", "s2", "--endpoint", "https://s", "--token", "t", "--local"], d)
    expect(d.fs.files.get(ignore)!.match(/hosts\.json/g)).toHaveLength(1)
  })

  it("host remove asks the host to revoke a paired device, and says when it could not", async () => {
    const revokeDevice = jest.fn(async () => ({
      deviceId: "dev_old",
      revoked: false,
      reason: "403 host.admin",
    }))
    const d = deps({ revokeDevice })
    seed(d, USER_FILE, { version: 1, active: "prod", hosts: { prod: PAIRED } })
    expect(await run(["host", "remove", "prod", "--format", "raw"], d)).toBe(EXIT_OK)
    expect(revokeDevice).toHaveBeenCalledWith(
      "prod",
      expect.objectContaining({ deviceId: "dev_old" }),
      expect.any(Number)
    )
    const result = JSON.parse(d.out.stdout)
    expect(result.revokedOnHost).toBe(false)
    expect(result.fix.join(" ")).toContain("cognia-server devices revoke-device dev_old")
    expect(parseHostsFile(d.fs.files.get(USER_FILE)!).hosts.prod).toBeUndefined()
  })

  it("host remove --keep-on-host skips the revocation and says the device stays", async () => {
    const revokeDevice = jest.fn()
    const d = deps({ revokeDevice })
    seed(d, USER_FILE, { version: 1, active: "prod", hosts: { prod: PAIRED } })
    expect(await run(["host", "remove", "prod", "--keep-on-host", "--format", "raw"], d)).toBe(
      EXIT_OK
    )
    expect(revokeDevice).not.toHaveBeenCalled()
    expect(JSON.parse(d.out.stdout).fix.join(" ")).toContain("dev_old")
  })

  it("re-pairing a saved device needs --replace, and then revokes the old device", async () => {
    const revokeDevice = jest.fn(async () => ({ deviceId: "dev_old", revoked: true }))
    const refused = deps({ revokeDevice, login: pairingLogin })
    seed(refused, USER_FILE, { version: 1, active: "prod", hosts: { prod: PAIRED } })
    expect(await run(loginArgs, refused)).toBe(EXIT_USAGE)
    expect(parseHostsFile(refused.fs.files.get(USER_FILE)!).hosts.prod.deviceId).toBe("dev_old")
    expect(revokeDevice).not.toHaveBeenCalled()

    const replaced = deps({ revokeDevice, login: pairingLogin })
    seed(replaced, USER_FILE, { version: 1, active: "prod", hosts: { prod: PAIRED } })
    expect(await run([...loginArgs, "--replace", "--format", "raw"], replaced)).toBe(EXIT_OK)
    expect(revokeDevice).toHaveBeenCalledTimes(1)
    expect(parseHostsFile(replaced.fs.files.get(USER_FILE)!).hosts.prod.deviceId).toBe("dev_new")
    expect(JSON.parse(replaced.out.stdout).replaced).toEqual({ deviceId: "dev_old", revoked: true })
  })

  it("reports an unreachable host as not revoked rather than assuming it", async () => {
    const { revokeOnHost } = await import("./host-command")
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as unknown as Record<
      string,
      unknown
    >
    const revocation = await revokeOnHost("prod", { ...PAIRED, devicePrivateKeyJwk: jwk }, 1_000, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED")
      },
    })
    expect(revocation).toMatchObject({ deviceId: "dev_old", revoked: false })
    expect(revocation.reason).toContain("ECONNREFUSED")
  })
})
