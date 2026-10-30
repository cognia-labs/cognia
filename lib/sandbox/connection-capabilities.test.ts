import type { SandboxConnectionDriver, SandboxConnectionProvider } from "@/types/sandbox"
import {
  SANDBOX_LIFECYCLE_OPERATIONS,
  delegatedManagedDesktopGui,
  hasCurrentManagedDesktopQualification,
  isDelegatedManagedDesktop,
  managedDesktopCapabilities,
  defaultSandboxCapabilities,
  narrowSandboxCapabilities,
  supportsSandboxOperation,
} from "./connection-capabilities"

const PROVIDERS: SandboxConnectionProvider[] = ["docker", "e2b", "cua-cloud", "lume"]
const DRIVERS: SandboxConnectionDriver[] = ["computer-server", "cua-driver"]

describe("managedDesktopCapabilities", () => {
  const projection = {
    qualification: "qualified" as const,
    qualificationEvidenceVersion: 2,
    workloadIsolationRevision: 1,
    egressEnforcement: "provider-and-guest-kernel" as const,
    agentControl: true,
  }
  it("keeps operations dormant unless the Host reports current recipe-8 qualification", () => {
    expect(managedDesktopCapabilities(projection).workspaceExec).toBe(false)
    const qualified = { ...projection, operationsQualified: true }
    expect(managedDesktopCapabilities(qualified).workspaceExec).toBe(true)
    expect(managedDesktopCapabilities(qualified).workspaceRead).toBe(true)
    expect(managedDesktopCapabilities({ ...qualified, agentControl: false }).workspaceExec).toBe(
      false
    )
    expect(
      managedDesktopCapabilities({ ...qualified, qualification: "unqualified" }).workspaceRead
    ).toBe(false)
  })
  it("adds only GUI to the E2B defaults under current Host enablement", () => {
    expect(managedDesktopCapabilities(projection)).toEqual({
      ...defaultSandboxCapabilities("e2b", "computer-server"),
      gui: true,
    })
  })
  it.each([
    { agentControl: false },
    { qualificationEvidenceVersion: 1 },
    { workloadIsolationRevision: 0 },
    { qualification: "unqualified" as const },
    { egressEnforcement: "unverified" as const },
  ])("refuses GUI for %j", (patch) => {
    expect(managedDesktopCapabilities({ ...projection, ...patch }).gui).toBe(false)
  })
})

describe("delegated managed desktop rows", () => {
  const config = {
    provider: "e2b" as const,
    target: { kind: "local" as const },
    providerConfigId: "byo",
    desktopId: "desktop",
    generation: 2,
    delegationId: "delegation",
    agentControl: true,
    qualification: "qualified" as const,
    qualificationEvidenceVersion: 2,
    workloadIsolationRevision: 1,
    egressEnforcement: "provider-and-guest-kernel" as const,
  }
  const row = { id: "managed:desktop:2", driver: "computer-server" as const, config }

  it("recognises only a local, delegated row under its exact routing id", () => {
    expect(isDelegatedManagedDesktop(row)).toBe(true)
    expect(delegatedManagedDesktopGui(row)).toBe(true)
    for (const other of [
      { ...row, id: "managed:desktop:3" },
      { ...row, id: "a-uuid" },
      { ...row, driver: "cua-driver" as const },
      { ...row, config: { ...config, delegationId: undefined } },
      { ...row, config: { ...config, target: { kind: "remote" as const, hostId: "h" } } },
      { ...row, config: undefined },
    ])
      expect(isDelegatedManagedDesktop(other)).toBe(false)
  })

  it("claims GUI only while the Host reports agent control and current evidence", () => {
    expect(delegatedManagedDesktopGui({ ...row, config: { ...config, agentControl: false } })).toBe(
      false
    )
    expect(
      delegatedManagedDesktopGui({ ...row, config: { ...config, qualification: "unqualified" } })
    ).toBe(false)
  })
})

describe("defaultSandboxCapabilities", () => {
  it("returns an entry for every operation, for every pair", () => {
    for (const provider of PROVIDERS) {
      for (const driver of DRIVERS) {
        const caps = defaultSandboxCapabilities(provider, driver)
        for (const op of SANDBOX_LIFECYCLE_OPERATIONS) {
          expect(typeof caps[op]).toBe("boolean")
        }
      }
    }
  })

  it("exposes only the implemented Docker/computer-server operations", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(caps.create).toBe(true)
    expect(caps.start).toBe(true)
    expect(caps.stop).toBe(true)
    expect(caps.delete).toBe(true)
    expect(caps.health).toBe(true)
    expect(caps.gui).toBe(true)
  })

  it("claims suspend and resume only because pause and unpause implement them", () => {
    // `docker pause` SIGSTOPs the container's processes and keeps its memory
    // resident, so the desktop session survives and this is a real suspend.
    // The claim would be false if the adapter used `docker stop`, which is a
    // different machine on the way back.
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(caps.suspend).toBe(true)
    expect(caps.resume).toBe(true)
  })

  it("carries Docker workspace shell and files, because docker exec was proven", () => {
    // Verified against a real container: `docker exec <id> hostname` returns
    // the container id rather than the host's, and its `/etc/os-release`
    // reports the image's distribution. The claim rests on that, not on what
    // the provider could support in principle.
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(caps.workspaceRead).toBe(true)
    expect(caps.workspaceExec).toBe(true)
  })

  it("withholds workspace access from providers with no adapter at all", () => {
    for (const provider of ["cua-cloud"] as const) {
      const caps = defaultSandboxCapabilities(provider, "computer-server")
      expect(caps.workspaceRead).toBe(false)
      expect(caps.workspaceExec).toBe(false)
    }
  })

  it("keeps cua-cloud rows readable without unsupported actions", () => {
    for (const provider of ["cua-cloud"] as const) {
      const caps = defaultSandboxCapabilities(provider, "cua-driver")
      expect(Object.values(caps).every((value) => value === false)).toBe(true)
    }
  })

  it("does not advertise health without a registered lifecycle adapter", () => {
    expect(defaultSandboxCapabilities("cua-cloud", "computer-server").health).toBe(false)
    expect(defaultSandboxCapabilities("lume", "computer-server").health).toBe(false)
  })

  it("supports Lume workspace access only through its registered driver", () => {
    // The computer-server driver carries workspace operations now. What keeps
    // them off a Lume row is that Lume has no adapter at all, so neither
    // driver can reach it.
    for (const driver of DRIVERS) {
      const caps = defaultSandboxCapabilities("lume", driver)
      expect(caps.workspaceRead).toBe(driver === "cua-driver")
      expect(caps.workspaceExec).toBe(driver === "cua-driver")
    }
  })

  it("keeps the unregistered cua-driver projection unavailable", () => {
    for (const provider of PROVIDERS.filter((candidate) => candidate !== "lume")) {
      expect(
        Object.values(defaultSandboxCapabilities(provider, "cua-driver")).every(
          (value) => value === false
        )
      ).toBe(true)
    }
  })

  it("returns a frozen object so a caller cannot widen it in place", () => {
    const caps = defaultSandboxCapabilities("docker", "cua-driver")
    expect(Object.isFrozen(caps)).toBe(true)
  })
})

describe("narrowSandboxCapabilities", () => {
  it("removes the listed operations", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    const narrowed = narrowSandboxCapabilities(caps, ["gui", "suspend"])
    expect(narrowed.gui).toBe(false)
    expect(narrowed.suspend).toBe(false)
    expect(narrowed.start).toBe(true)
  })

  it("never widens", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(narrowSandboxCapabilities(caps, []).connect).toBe(false)
  })

  it("does not mutate the input", () => {
    const caps = defaultSandboxCapabilities("cua-cloud", "cua-driver")
    narrowSandboxCapabilities(caps, ["gui"])
    expect(caps.gui).toBe(false)
  })

  it("is a no-op for an empty removal list", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(narrowSandboxCapabilities(caps, [])).toEqual(caps)
  })

  it("never re-enables an already-false capability", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(narrowSandboxCapabilities(caps, ["connect"]).connect).toBe(false)
  })
})

describe("supportsSandboxOperation", () => {
  it("reads the matrix", () => {
    const caps = defaultSandboxCapabilities("docker", "computer-server")
    expect(supportsSandboxOperation(caps, "start")).toBe(true)
    expect(supportsSandboxOperation(caps, "connect")).toBe(false)
  })
})

describe("hasCurrentManagedDesktopQualification", () => {
  const current = {
    qualification: "qualified" as const,
    qualificationEvidenceVersion: 2,
    workloadIsolationRevision: 1,
    egressEnforcement: "provider-and-guest-kernel" as const,
  }

  it("accepts only the complete current Host projection", () => {
    expect(hasCurrentManagedDesktopQualification(current)).toBe(true)
  })

  it.each([
    { qualification: "unqualified" },
    { qualificationEvidenceVersion: undefined },
    { qualificationEvidenceVersion: null },
    { qualificationEvidenceVersion: 0 },
    { qualificationEvidenceVersion: 1 },
    { qualificationEvidenceVersion: 3 },
    { workloadIsolationRevision: undefined },
    { workloadIsolationRevision: 0 },
    { workloadIsolationRevision: 2 },
    { egressEnforcement: undefined },
    { egressEnforcement: "provider-enforced" },
    { egressEnforcement: "unverified" },
  ])("keeps legacy, missing or incompatible proof dormant: %j", (change) => {
    expect(hasCurrentManagedDesktopQualification({ ...current, ...change } as typeof current)).toBe(
      false
    )
  })
})
