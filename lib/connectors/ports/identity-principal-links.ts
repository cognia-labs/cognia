// The connectors' member of the `identity-principal-links` collection port
// (`types/modules/ports/identity-principal-links.ts`, ADR-0250 §14): each IM
// vendor that keeps a principal registry contributes `principalLinks` through
// the vendor seam, and this member asks them in catalog order, so the
// framework names no vendor.

import type { IdentityPrincipalLinks } from "@/types/modules/ports/identity-principal-links"
import { connectorVendors } from "../vendor-contribution"

function linkingVendors() {
  return connectorVendors().flatMap((vendor) =>
    vendor.principalLinks ? [vendor.principalLinks] : []
  )
}

export const port: IdentityPrincipalLinks = {
  async attachSignIn(input) {
    const report = { attached: [] as string[], foreign: [] as string[] }
    for (const links of linkingVendors()) {
      const { attached, foreign } = await links.attachSignIn(input)
      report.attached.push(...attached)
      report.foreign.push(...foreign)
    }
    return report
  },
  async unlinkSelfBound(input) {
    const unlinked: string[] = []
    for (const links of linkingVendors()) unlinked.push(...(await links.unlinkSelfBound(input)))
    return unlinked
  },
}
