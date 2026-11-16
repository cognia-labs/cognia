import {
  COMPOSER_MEMORY_TARGETS,
  isMemoryTargetAvailable,
  memoryFilesUnavailableKey,
  memoryTargetKey,
  parseMemoryTargetKey,
  resolveMemoryFilesAccess,
  type ComposerMemoryTarget,
} from "./memory-target"

describe("COMPOSER_MEMORY_TARGETS", () => {
  it("offers the two store scopes before the two file scopes", () => {
    expect(COMPOSER_MEMORY_TARGETS.map(memoryTargetKey)).toEqual([
      "store:global",
      "store:workspace",
      "file:project",
      "file:user",
    ])
  })

  it("does not offer the context-derived store scopes", () => {
    const scopes = COMPOSER_MEMORY_TARGETS.map((t) => t.scope)
    expect(scopes).not.toContain("character")
    expect(scopes).not.toContain("agent")
  })
})

describe("memoryTargetKey / parseMemoryTargetKey", () => {
  it("round-trips every offered target", () => {
    for (const target of COMPOSER_MEMORY_TARGETS) {
      expect(parseMemoryTargetKey(memoryTargetKey(target))).toEqual(target)
    }
  })

  it("returns null for unknown, empty or nullish keys", () => {
    expect(parseMemoryTargetKey("store:character")).toBeNull()
    expect(parseMemoryTargetKey("file:global")).toBeNull()
    expect(parseMemoryTargetKey("nonsense")).toBeNull()
    expect(parseMemoryTargetKey("")).toBeNull()
    expect(parseMemoryTargetKey(null)).toBeNull()
    expect(parseMemoryTargetKey(undefined)).toBeNull()
  })
})

describe("isMemoryTargetAvailable", () => {
  const file: ComposerMemoryTarget = { target: "file", scope: "project" }
  const store: ComposerMemoryTarget = { target: "store", scope: "global" }

  it("allows store writes wherever the files are out of reach", () => {
    for (const access of ["available", "desktop-only", "remote-host"] as const) {
      expect(isMemoryTargetAvailable(store, access)).toBe(true)
    }
  })

  it("allows file writes only where the loaded files are reachable", () => {
    expect(isMemoryTargetAvailable(file, "available")).toBe(true)
    expect(isMemoryTargetAvailable(file, "desktop-only")).toBe(false)
    expect(isMemoryTargetAvailable(file, "remote-host")).toBe(false)
  })
})

describe("resolveMemoryFilesAccess", () => {
  const remote = { kind: "remote" as const, hostId: "host-b" }

  it("needs a project filesystem in this window", () => {
    expect(resolveMemoryFilesAccess({ isDesktop: false, drivingRemoteHost: false })).toBe(
      "desktop-only"
    )
  })

  it("refuses a conversation whose turns run on a remote Host", () => {
    // Its turns load that Host's files; writing this disk would be the wrong file.
    expect(
      resolveMemoryFilesAccess({ isDesktop: true, boundOrigin: remote, drivingRemoteHost: false })
    ).toBe("remote-host")
  })

  it("refuses while the desktop drives a remote Host", () => {
    expect(resolveMemoryFilesAccess({ isDesktop: true, drivingRemoteHost: true })).toBe(
      "remote-host"
    )
  })

  it("allows a conversation on this computer", () => {
    expect(
      resolveMemoryFilesAccess({
        isDesktop: true,
        boundOrigin: { kind: "local" },
        drivingRemoteHost: false,
      })
    ).toBe("available")
    expect(resolveMemoryFilesAccess({ isDesktop: true, drivingRemoteHost: false })).toBe(
      "available"
    )
  })

  it("names the message for each refusal", () => {
    expect(memoryFilesUnavailableKey("available")).toBeNull()
    expect(memoryFilesUnavailableKey("desktop-only")).toBe("desktopOnly")
    expect(memoryFilesUnavailableKey("remote-host")).toBe("remoteHost")
  })
})
