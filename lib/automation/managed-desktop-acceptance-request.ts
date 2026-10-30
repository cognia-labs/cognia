/** One-shot, in-memory bridge from a proposal card to the existing settings panel. */
import { managedDesktopIdentityScope } from "./managed-desktop-client"
import {
  validManagedDesktopCriteria,
  type ManagedDesktopAcceptanceCriterion,
} from "./managed-desktop-handoff-client"

export interface AcceptancePanelRequest {
  deliveryId: string
  criteria: ManagedDesktopAcceptanceCriterion[]
}
let pending: AcceptancePanelRequest | undefined
let identity: ReturnType<typeof managedDesktopIdentityScope> | undefined
const listeners = new Set<() => void>()

export function requestAcceptancePanel(request: AcceptancePanelRequest): void {
  if (!request.deliveryId.trim() || !validManagedDesktopCriteria(request.criteria))
    throw new Error("managed_desktop_acceptance_invalid_proposal")
  identity?.dispose()
  identity = managedDesktopIdentityScope({ kind: "local" }, () => {
    pending = undefined
  })
  identity.assertActive()
  pending = {
    deliveryId: request.deliveryId,
    criteria: request.criteria.map((row) => ({ ...row })),
  }
  listeners.forEach((listener) => listener())
}

export function consumeAcceptancePanelRequest(): AcceptancePanelRequest | undefined {
  try {
    identity?.assertActive()
    return pending
  } catch {
    return undefined
  } finally {
    pending = undefined
    identity?.dispose()
    identity = undefined
  }
}

export function subscribeAcceptancePanelRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
