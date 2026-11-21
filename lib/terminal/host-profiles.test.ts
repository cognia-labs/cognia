let mockChain: string[] = ["tauri-channel"]
jest.mock("./pick-transport", () => ({
  selectTerminalTransportChain: () => mockChain,
}))

import {
  ADHOC_PROFILE_ID,
  __resetTerminalHostProfileSyncForTests,
  acquireRemoteLaunchProfile,
  buildSynchronizedSshProfiles,
  buildSynchronizedTerminalProfiles,
  ensureRemoteSpawnProfile,
  ensureTerminalHostProfilesSynced,
  hasTransientTerminalProfile,
  registerTransientTerminalProfile,
  removeTransientTerminalProfile,
  syncTerminalHostProfiles,
} from "./host-profiles"

beforeEach(() => {
  mockChain = ["tauri-channel"]
  __resetTerminalHostProfileSyncForTests()
})

describe("transient user-launched terminal profiles", () => {
  const request = {
    profileId: "cognia-agent-terminal-freebuff",
    shell: "freebuff",
    args: [],
    cwd: "/workspace with spaces",
    rows: 24,
    cols: 80,
    enableShellIntegration: false,
    forceUtf8: false,
  }

  function deps() {
    return {
      call: jest.fn(async (_method: string, _payload: unknown) => undefined) as jest.Mock,
      readSettings: jest.fn(async () => ({
        terminal: { profiles: [{ id: "saved", name: "Saved", shell: "/bin/bash" }] },
      })),
      resolveTarget: jest.fn(async () => "original-host-and-account"),
    }
  }

  it("syncs the fixed executable/argv alongside saved profiles through the gated host API", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    await expect(ensureRemoteSpawnProfile(request, sync)).resolves.toBe(request.profileId)
    expect(sync.call).toHaveBeenCalledWith("terminal_host_sync_profiles", {
      profiles: [
        expect.objectContaining({ profileId: "saved" }),
        { profileId: request.profileId, request },
      ],
    })
  })

  it("does not silently use a stale host profile if synchronization or capability checks fail", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    sync.call.mockRejectedValueOnce(new Error("terminal.open capability denied"))
    await expect(ensureRemoteSpawnProfile(request, sync)).rejects.toThrow(
      "terminal.open capability denied"
    )
    expect(hasTransientTerminalProfile(request.profileId)).toBe(true)
    await expect(ensureRemoteSpawnProfile(request, sync)).resolves.toBe(request.profileId)
  })

  it("synchronizes the policy-mutated workspace and sandbox request rather than its earlier draft", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    await ensureRemoteSpawnProfile({ ...request, cwd: "/policy-approved", sandboxed: true }, sync)
    expect(sync.call).toHaveBeenCalledWith("terminal_host_sync_profiles", {
      profiles: [
        expect.anything(),
        {
          profileId: request.profileId,
          request: expect.objectContaining({
            cwd: "/policy-approved",
            sandboxed: true,
            enableShellIntegration: false,
          }),
        },
      ],
    })
  })

  it("serializes device-scoped profile replacements so concurrent agents preserve each other", async () => {
    mockChain = ["ws"]
    const sync = deps()
    let active = 0
    let maximum = 0
    sync.call.mockImplementation(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active -= 1
    })
    const other = { ...request, profileId: "cognia-agent-terminal-zcode", shell: "zcode" }
    registerTransientTerminalProfile(request)
    registerTransientTerminalProfile(other)
    await Promise.all([
      ensureRemoteSpawnProfile(request, sync),
      ensureRemoteSpawnProfile(other, sync),
    ])
    expect(maximum).toBe(1)
    const last = sync.call.mock.calls.at(-1)![1] as { profiles: { profileId: string }[] }
    expect(last.profiles.map((profile) => profile.profileId)).toEqual([
      "saved",
      request.profileId,
      other.profileId,
    ])
  })

  it("removes only transient metadata and retains failed cleanup for retry", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    await ensureRemoteSpawnProfile(request, sync)
    sync.call.mockRejectedValueOnce(new Error("host offline"))
    await expect(removeTransientTerminalProfile(request.profileId, sync)).rejects.toThrow(
      "host offline"
    )
    expect(hasTransientTerminalProfile(request.profileId)).toBe(true)
    await expect(ensureRemoteSpawnProfile(request, sync)).rejects.toThrow("cleanup is pending")
    await removeTransientTerminalProfile(request.profileId, sync)
    expect(hasTransientTerminalProfile(request.profileId)).toBe(false)
    expect(sync.call).toHaveBeenLastCalledWith("terminal_host_sync_profiles", {
      profiles: [expect.objectContaining({ profileId: "saved" })],
    })
  })

  it("refuses profile cleanup on a different host/account and succeeds after returning", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile(request)
    await ensureRemoteSpawnProfile(request, sync)
    sync.resolveTarget.mockResolvedValueOnce("different-host-or-account")
    await expect(removeTransientTerminalProfile(request.profileId, sync)).rejects.toThrow(
      "original terminal host"
    )
    expect(sync.call).toHaveBeenCalledTimes(1)
    expect(hasTransientTerminalProfile(request.profileId)).toBe(true)
    await removeTransientTerminalProfile(request.profileId, sync)
    expect(hasTransientTerminalProfile(request.profileId)).toBe(false)
  })

  it("rechecks the host after asynchronously loading settings before sending launch metadata", async () => {
    mockChain = ["ws"]
    const sync = deps()
    let target = "original-host-and-account"
    sync.resolveTarget.mockImplementation(async () => target)
    const saved = await sync.readSettings()
    sync.readSettings.mockImplementationOnce(async () => {
      target = "different-host-or-account"
      return saved
    })
    registerTransientTerminalProfile(request)
    await expect(ensureRemoteSpawnProfile(request, sync)).rejects.toThrow("original terminal host")
    expect(sync.call).not.toHaveBeenCalled()
  })

  it("does not override a saved profile or accept an ambiguous identity", async () => {
    mockChain = ["ws"]
    const sync = deps()
    registerTransientTerminalProfile({ ...request, profileId: "saved" })
    await expect(
      ensureRemoteSpawnProfile({ ...request, profileId: "saved" }, sync)
    ).rejects.toThrow("conflicts with a saved profile")
    expect(sync.call).not.toHaveBeenCalled()
    for (const profileId of [undefined, "default", ADHOC_PROFILE_ID]) {
      expect(() => registerTransientTerminalProfile({ ...request, profileId })).toThrow(
        "distinct identity"
      )
    }
  })

  it("cleans a local profile without contacting another host", async () => {
    const sync = deps()
    registerTransientTerminalProfile(request)
    await removeTransientTerminalProfile(request.profileId, sync)
    expect(sync.call).not.toHaveBeenCalled()
    expect(sync.resolveTarget).not.toHaveBeenCalled()
    expect(hasTransientTerminalProfile(request.profileId)).toBe(false)
  })
})

describe("terminal host profile synchronization", () => {
  it("sends only complete named profiles and preserves sandbox policy", () => {
    expect(
      buildSynchronizedTerminalProfiles(
        [
          { id: "blank", name: "Blank", shell: "" },
          {
            id: "build",
            name: "Build",
            shell: "/bin/zsh",
            args: ["-l"],
            cwd: "/workspace",
            env: { TERM_FEATURE: "1" },
          },
        ],
        { sandboxed: true, forceUtf8: false }
      )
    ).toEqual([
      {
        profileId: "build",
        request: expect.objectContaining({
          shell: "/bin/zsh",
          args: ["-l"],
          cwd: "/workspace",
          env: { TERM_FEATURE: "1" },
          rows: 24,
          cols: 80,
          sandboxed: true,
          forceUtf8: false,
        }),
      },
    ])
  })

  it("synchronizes secret-free SSH profiles by stable identifier", () => {
    expect(
      buildSynchronizedSshProfiles([
        {
          id: "invalid",
          name: "Invalid",
          host: "bad host",
          port: 22,
          username: "deploy",
          authMethod: "password",
        },
        {
          id: "production",
          name: "Production",
          host: "server.example.com",
          port: 2222,
          username: "deploy",
          authMethod: "privateKey",
          privateKeyPath: "~/.ssh/id_ed25519",
          credentialRef: "production",
        },
      ])
    ).toEqual([
      {
        profileId: "production",
        request: expect.objectContaining({
          profileId: "production",
          host: "server.example.com",
          port: 2222,
          rows: 24,
          cols: 80,
          credentialRef: "production",
        }),
      },
    ])
  })

  it("synchronizes the jump chain but never a forwarding rule", () => {
    // A synchronized profile is what a phone, a LAN client, or SFTP names to
    // reach a machine. Forwarding here would let a remote client make the
    // desktop open a listening port, which ADR-0082 §9 forbids, so stripping it
    // is pinned rather than left to happenstance. The jump chain is the
    // opposite case: it opens nothing, and without it a bastion-backed host is
    // dialed direct, which reaches a different machine or none.
    const bastion = {
      id: "bastion",
      name: "Bastion",
      host: "jump.example.com",
      port: 2200,
      username: "jumper",
      authMethod: "password" as const,
      credentialRef: "bastion",
    }
    const synchronized = buildSynchronizedSshProfiles([
      bastion,
      {
        id: "production",
        name: "Production",
        host: "server.example.com",
        port: 22,
        username: "deploy",
        authMethod: "agent",
        jumpHostId: "bastion",
        localForwards: [
          {
            id: "lfwd-1",
            localPort: 8080,
            remoteHost: "db.internal",
            remotePort: 5432,
            enabled: true,
          },
        ],
        remoteForwards: [
          {
            id: "rfwd-1",
            remotePort: 9000,
            localHost: "localhost",
            localPort: 3000,
            enabled: true,
          },
        ],
      },
    ])
    const production = synchronized.find((entry) => entry.profileId === "production")!

    expect(production.request.jumpChain).toEqual([
      {
        host: "jump.example.com",
        port: 2200,
        username: "jumper",
        authMethod: "password",
        credentialRef: "bastion",
        privateKeyPath: undefined,
      },
    ])
    expect(production.request).not.toHaveProperty("localForwards")
    expect(production.request).not.toHaveProperty("remoteForwards")
    // A direct host carries no empty chain field at all.
    expect(synchronized.find((entry) => entry.profileId === "bastion")!.request).not.toHaveProperty(
      "jumpChain"
    )
  })

  it("leaves out a profile whose chain cannot be walked rather than syncing it direct", () => {
    const synchronized = buildSynchronizedSshProfiles([
      {
        id: "orphan",
        name: "Orphan",
        host: "server.example.com",
        port: 22,
        username: "deploy",
        authMethod: "agent",
        jumpHostId: "deleted-bastion",
      },
    ])
    expect(synchronized).toEqual([])
  })

  it("replaces the host profile set, including clearing deleted profiles", async () => {
    const call = jest.fn(async (_method: string, _payload: unknown) => undefined)
    await syncTerminalHostProfiles([], {}, call as never)
    expect(call).toHaveBeenCalledWith("terminal_host_service", {
      action: { kind: "syncProfiles", profiles: [], sshProfiles: [] },
    })
  })

  // Two commands, two authorities: the local one also owns `provision` and the
  // login-service registration and stays local; the remote one is gated on
  // `terminal.open` and scoped to the calling device.
  it("uses the capability-gated RPC against a remote host", async () => {
    mockChain = ["ws", "webrtc"]
    const call = jest.fn(async (_method: string, _payload: unknown) => undefined)
    await syncTerminalHostProfiles(
      [{ id: "build", name: "Build", shell: "/bin/bash" }],
      {},
      call as never
    )
    const [command, payload] = call.mock.calls[0] as unknown as [
      string,
      { profiles: { profileId: string }[] },
    ]
    expect(command).toBe("terminal_host_sync_profiles")
    expect(payload.profiles.map((entry) => entry.profileId)).toEqual(["build"])
  })

  // An SSH profile names a destination and a credential. Installing one from a
  // paired device would let it drive outbound connections from the host, so the
  // Rust arm refuses them and the client must not send them either.
  it("never sends SSH profiles to a remote host", async () => {
    mockChain = ["ws"]
    const call = jest.fn(async (_method: string, _payload: unknown) => undefined)
    await syncTerminalHostProfiles(
      [],
      {
        sshProfiles: [
          {
            id: "prod",
            name: "prod",
            host: "example.com",
            username: "root",
            auth: "agent",
          } as never,
        ],
      },
      call as never
    )
    expect(call.mock.calls[0][1]).toEqual({ profiles: [] })
  })

  // A remote spawn frame carries a profile id and nothing else, so a shell the
  // user picked has to arrive as a profile or it is silently replaced by the
  // host's bootstrap default.
  it("carries an ad-hoc spawn alongside the saved profiles, never instead of them", async () => {
    mockChain = ["ws"]
    const call = jest.fn(async (_method: string, _payload: unknown) => undefined)
    await syncTerminalHostProfiles(
      [{ id: "build", name: "Build", shell: "/bin/bash" }],
      { adHoc: { shell: "/bin/zsh", rows: 24, cols: 80 } },
      call as never
    )
    const payload = call.mock.calls[0][1] as unknown as {
      profiles: { profileId: string; request: { shell: string } }[]
    }
    expect(payload.profiles.map((entry) => entry.profileId)).toEqual(["build", ADHOC_PROFILE_ID])
    expect(payload.profiles.at(-1)?.request.shell).toBe("/bin/zsh")
  })

  it("gives concurrent ad-hoc launches distinct wire ids and preserves pending agent profiles (T02)", async () => {
    mockChain = ["ws"]
    const calls: Array<{
      profiles: Array<{ profileId: string; request: { shell: string; cwd?: string } }>
    }> = []
    const call = jest.fn(async (_method: string, payload: unknown) => {
      calls.push(payload as (typeof calls)[number])
      await Promise.resolve()
    })
    const readSettings = jest.fn(async () => ({
      terminal: { profiles: [{ id: "saved", name: "Saved", shell: "/bin/bash" }] },
    }))
    const resolveTarget = jest.fn(async () => "same-host-same-device")

    registerTransientTerminalProfile({
      profileId: "cognia-agent-terminal-claude",
      shell: "claude",
      args: ["--resume"],
      rows: 24,
      cols: 80,
    })
    await ensureRemoteSpawnProfile(
      {
        profileId: "cognia-agent-terminal-claude",
        shell: "claude",
        args: ["--resume"],
        rows: 24,
        cols: 80,
      },
      { call: call as never, readSettings, resolveTarget }
    )

    const [first, second] = await Promise.all([
      acquireRemoteLaunchProfile(
        { shell: "/bin/zsh", cwd: "/worktree-a", rows: 24, cols: 80 },
        { call: call as never, readSettings, resolveTarget }
      ),
      acquireRemoteLaunchProfile(
        { shell: "/usr/local/bin/fish", cwd: "/worktree-b", rows: 24, cols: 80 },
        { call: call as never, readSettings, resolveTarget }
      ),
    ])

    expect(first.profileId).not.toBe(second.profileId)
    const latest = calls.at(-1)!.profiles
    expect(latest.find((p) => p.profileId === "cognia-agent-terminal-claude")).toBeDefined()
    expect(latest.find((p) => p.profileId === first.profileId)?.request).toMatchObject({
      shell: "/bin/zsh",
      cwd: "/worktree-a",
    })
    expect(latest.find((p) => p.profileId === second.profileId)?.request).toMatchObject({
      shell: "/usr/local/bin/fish",
      cwd: "/worktree-b",
    })

    // Ordinary settings sync while launches are still in flight also preserves them.
    await syncTerminalHostProfiles(
      [{ id: "saved", name: "Saved", shell: "/bin/bash" }],
      { targetKey: "same-host-same-device" },
      call as never
    )
    expect(calls.at(-1)!.profiles.map((p) => p.profileId)).toEqual(
      expect.arrayContaining([
        "saved",
        "cognia-agent-terminal-claude",
        first.profileId,
        second.profileId,
      ])
    )

    first.release()
    second.release()
  })

  it("preserves per-launch cwd, projectId, and sandbox overrides on remote named profiles (T01)", async () => {
    mockChain = ["ws"]
    const call = jest.fn(async (_method: string, _payload: unknown) => undefined)
    const lease = await acquireRemoteLaunchProfile(
      {
        profileId: "build",
        shell: "/bin/zsh",
        args: ["-l"],
        cwd: "/worktrees/feature-branch",
        projectId: "proj-worktree",
        sandboxed: true,
        rows: 30,
        cols: 100,
      },
      {
        call: call as never,
        readSettings: async () => ({
          terminal: {
            profiles: [{ id: "build", name: "Build", shell: "/bin/zsh", cwd: "/default-root" }],
          },
        }),
        resolveTarget: async () => "remote-host-a",
      }
    )

    expect(lease.logicalProfileId).toBe("build")
    expect(lease.profileId).toMatch(/^__launch:build:/)
    const payload = call.mock.calls[0][1] as {
      profiles: Array<{ profileId: string; request: Record<string, unknown> }>
    }
    const launchEntry = payload.profiles.find((p) => p.profileId === lease.profileId)
    expect(launchEntry?.request).toMatchObject({
      profileId: "build",
      shell: "/bin/zsh",
      cwd: "/worktrees/feature-branch",
      projectId: "proj-worktree",
      sandboxed: true,
    })
    lease.release()
  })

  it("acquires an interactive adminLease when synchronizing profiles to a remote target (T13)", async () => {
    mockChain = ["ws"]
    const targetCalls: Array<[string, unknown]> = []
    const targetTransport = {
      call: jest.fn(async (cmd: string, args?: Record<string, unknown>) => {
        targetCalls.push([cmd, args])
        if (cmd === "host_admin_lease_issue") {
          return {
            token: "lease-sync-1",
            operations: ["terminal_host_sync_profiles"],
            expiresAt: Date.now() + 60_000,
          }
        }
        return { installed: 1 }
      }),
    }

    await syncTerminalHostProfiles([{ id: "build", name: "Build", shell: "/bin/bash" }], {
      interactive: true,
      targetKey: "remote-host-lease-test",
      targetTransport: targetTransport as never,
    })

    expect(targetCalls[0][0]).toBe("host_admin_lease_issue")
    expect(targetCalls[1][0]).toBe("terminal_host_sync_profiles")
    expect(targetCalls[1][1]).toMatchObject({
      adminLease: "lease-sync-1",
    })
  })

  it("does not cache local no-ops or failed syncs across host switches (T05)", async () => {
    jest.doMock("@/stores/settings/settings-store", () => ({
      useSettingsStore: {
        getState: () => ({
          loaded: true,
          settings: {
            terminal: { profiles: [{ id: "dev", name: "Dev", shell: "/bin/zsh" }] },
          },
        }),
        subscribe: () => () => undefined,
      },
    }))
    // Local no-op first
    mockChain = ["tauri-channel"]
    const call = jest.fn(async () => undefined)
    await ensureTerminalHostProfilesSynced({ targetKey: "host-a", call: call as never })
    expect(call).not.toHaveBeenCalled()

    // Switch to remote Host A: must actually sync, and retry if first attempt fails
    mockChain = ["ws"]
    call.mockRejectedValueOnce(new Error("temporary network drop"))
    await ensureTerminalHostProfilesSynced({ targetKey: "host-a", call: call as never })
    expect(call).toHaveBeenCalledTimes(1)

    await ensureTerminalHostProfilesSynced({ targetKey: "host-a", call: call as never })
    expect(call).toHaveBeenCalledTimes(2)

    // Switch to Host B: must sync again under the new targetKey
    await ensureTerminalHostProfilesSynced({ targetKey: "host-b", call: call as never })
    expect(call).toHaveBeenCalledTimes(3)
  })
})
