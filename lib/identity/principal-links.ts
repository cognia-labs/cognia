/**
 * The identity plane's side of the `identity-principal-links` collection port
 * (`types/modules/ports/identity-principal-links.ts`): a sign-in reaches every
 * principal registry a module keeps, and a sign-out or takeover unlinks what
 * the departing binding admitted, without the plane importing a registry.
 *
 * Every member is asked in registry order. A member that fails, or whose file
 * does not load, is logged and the others still run; a change of the local
 * profile under the call still throws (`assertCurrent`), as it did when the
 * plane called the one registry directly.
 */

import { loggers } from "@cognia/logging"
import { loadPortCollection } from "@/lib/modules/ports"
import type {
  IdentityPrincipalLinks,
  PrincipalSelfBoundUnlinkInput,
  PrincipalSignInAttachInput,
  PrincipalSignInAttachReport,
} from "@/types/modules/ports/identity-principal-links"

async function eachMember(
  operation: string,
  run: (member: IdentityPrincipalLinks) => Promise<void>
): Promise<void> {
  const { members, failures } = await loadPortCollection("identity-principal-links")
  for (const failure of failures)
    loggers.auth.error("principal links failed to load", {
      module: failure.module,
      error: String(failure.error),
    })
  for (const { module, port } of members) {
    try {
      await run(port)
    } catch (error) {
      loggers.auth.error(`principal links could not ${operation}`, {
        module,
        error: String(error),
      })
    }
  }
}

/** Attach a sign-in to every registry's principals of the signed-in person. */
export async function attachSignInToPrincipals(
  input: PrincipalSignInAttachInput
): Promise<PrincipalSignInAttachReport> {
  const report: PrincipalSignInAttachReport = { attached: [], foreign: [] }
  await eachMember("attach the sign-in", async (member) => {
    const { attached, foreign } = await member.attachSignIn(input)
    report.attached.push(...attached)
    report.foreign.push(...foreign)
  })
  input.assertCurrent?.()
  return report
}

/** Unlink what a departing profile binding admitted, in every registry. */
export async function unlinkSelfBoundPrincipals(
  input: PrincipalSelfBoundUnlinkInput
): Promise<string[]> {
  const unlinked: string[] = []
  await eachMember("unlink self-bound principals", async (member) => {
    unlinked.push(...(await member.unlinkSelfBound(input)))
  })
  input.assertCurrent?.()
  return unlinked
}
