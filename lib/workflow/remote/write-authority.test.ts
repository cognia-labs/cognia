import { workflowWriteAuthority } from "./write-authority"
import {
  __resetRuntimeSnapshotForTesting,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"

afterEach(() => __resetRuntimeSnapshotForTesting())

describe("workflowWriteAuthority", () => {
  it("is local on a shell that is its own Host (no runtime target)", () => {
    setRuntimeSnapshot({ target: null, vaultState: "unavailable", connectionState: "offline" })
    expect(workflowWriteAuthority()).toBe("local")
  })

  it("is local on a standalone phone or browser", () => {
    setRuntimeSnapshot({
      target: { id: "standalone", kind: "standalone", platform: "mobile" },
      vaultState: "unlocked",
      connectionState: "online",
    } as never)
    expect(workflowWriteAuthority()).toBe("local")
  })

  it("is the Host on a paired companion", () => {
    setRuntimeSnapshot({
      target: {
        id: "mobile-companion",
        kind: "companion",
        platform: "mobile",
        hostKind: "desktop",
      },
      vaultState: "unlocked",
      connectionState: "online",
    } as never)
    expect(workflowWriteAuthority()).toBe("host")
  })
})
