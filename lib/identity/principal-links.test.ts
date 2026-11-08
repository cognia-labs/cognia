import { loggers } from "@cognia/logging"
import type { HostModuleManifest } from "@/lib/modules/manifest-types"
import { __resetPortsForTesting, __setPortModulesForTesting } from "@/lib/modules/ports"
import type {
  IdentityPrincipalLinks,
  PrincipalSelfBoundUnlinkInput,
  PrincipalSignInAttachInput,
} from "@/types/modules/ports/identity-principal-links"
import { attachSignInToPrincipals, unlinkSelfBoundPrincipals } from "./principal-links"

function moduleProviding(id: string, load: () => Promise<unknown>): HostModuleManifest {
  return {
    id,
    kind: "module",
    stage: "stable",
    provides: [{ port: "identity-principal-links", load }],
  } as unknown as HostModuleManifest
}

function member(attached: string[], foreign: string[], unlinked: string[]) {
  return {
    attachSignIn: jest.fn(async (_input: PrincipalSignInAttachInput) => ({ attached, foreign })),
    unlinkSelfBound: jest.fn(async (_input: PrincipalSelfBoundUnlinkInput) => unlinked),
  } satisfies IdentityPrincipalLinks
}

const attachInput = { userId: "u1", logtoSubject: "sub", identities: [] }
const unlinkInput = { localAccountId: "acct", userId: "u1" }

let errorLog: jest.SpyInstance
beforeEach(() => {
  errorLog = jest.spyOn(loggers.auth, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  __resetPortsForTesting()
  errorLog.mockRestore()
})

describe("principal links", () => {
  it("asks every registry and merges their reports", async () => {
    const connectors = member(["fp_1"], ["fp_x"], ["fp_1"])
    const collab = member(["cp_1"], [], ["cp_2"])
    __setPortModulesForTesting([
      moduleProviding("connectors", async () => ({ port: connectors })),
      moduleProviding("collab", async () => ({ port: collab })),
    ])
    await expect(attachSignInToPrincipals(attachInput)).resolves.toEqual({
      attached: ["fp_1", "cp_1"],
      foreign: ["fp_x"],
    })
    expect(connectors.attachSignIn).toHaveBeenCalledWith(attachInput)
    await expect(unlinkSelfBoundPrincipals(unlinkInput)).resolves.toEqual(["fp_1", "cp_2"])
    expect(collab.unlinkSelfBound).toHaveBeenCalledWith(unlinkInput)
  })

  it("is empty when no module keeps a registry", async () => {
    __setPortModulesForTesting([])
    await expect(attachSignInToPrincipals(attachInput)).resolves.toEqual({
      attached: [],
      foreign: [],
    })
    await expect(unlinkSelfBoundPrincipals(unlinkInput)).resolves.toEqual([])
  })

  it("logs a failing or unloadable member and still asks the others", async () => {
    const collab = member(["cp_1"], [], ["cp_2"])
    const failing: IdentityPrincipalLinks = {
      attachSignIn: async () => {
        throw new Error("registry down")
      },
      unlinkSelfBound: async () => {
        throw new Error("registry down")
      },
    }
    __setPortModulesForTesting([
      moduleProviding("connectors", async () => ({ port: failing })),
      moduleProviding("broken", async () => {
        throw new Error("chunk failed")
      }),
      moduleProviding("collab", async () => ({ port: collab })),
    ])
    await expect(attachSignInToPrincipals(attachInput)).resolves.toEqual({
      attached: ["cp_1"],
      foreign: [],
    })
    await expect(unlinkSelfBoundPrincipals(unlinkInput)).resolves.toEqual(["cp_2"])
    expect(errorLog).toHaveBeenCalledWith("principal links failed to load", {
      module: "broken",
      error: "Error: chunk failed",
    })
    expect(errorLog).toHaveBeenCalledWith("principal links could not attach the sign-in", {
      module: "connectors",
      error: "Error: registry down",
    })
    expect(errorLog).toHaveBeenCalledWith(
      "principal links could not unlink self-bound principals",
      { module: "connectors", error: "Error: registry down" }
    )
  })

  it("still throws when the local profile changed under the call", async () => {
    __setPortModulesForTesting([
      moduleProviding("connectors", async () => ({ port: member([], [], []) })),
    ])
    const assertCurrent = () => {
      throw new Error("The local profile changed.")
    }
    await expect(attachSignInToPrincipals({ ...attachInput, assertCurrent })).rejects.toThrow(
      "The local profile changed."
    )
    await expect(unlinkSelfBoundPrincipals({ ...unlinkInput, assertCurrent })).rejects.toThrow(
      "The local profile changed."
    )
  })
})
