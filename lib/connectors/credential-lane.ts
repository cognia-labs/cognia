/**
 * The credential lane a connector turn records when it is admitted
 * (ADR-0243 §3, phase 4 D5/D6). It is fixed on the run from then on.
 *
 * - The bot account set to `service` runs every turn on the app's service
 *   credentials.
 * - Otherwise (`delegated`, the IM default) a turn acts as its requester,
 *   with their own authorization, only when the platform holds per-person
 *   authorizations and the principal registry resolved the sender. Without
 *   either the turn stays `legacy`, which gets no personal access.
 */
import type {
  CredentialLaneV1,
  PrincipalRefV1,
} from "@cognia/plugin-contract/types/execution/acting-identity"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { connectorRequester } from "@/lib/execution/acting-authority"
import { readResolvedPrincipal } from "@/lib/execution/resolved-principal"
import { connectorVendor } from "./vendor-contribution"

export function connectorTurnLane(
  row: Pick<AdapterInstanceRow, "type" | "credentialLane">,
  event: NormalizedInboundEvent
):
  | { lane: Extract<CredentialLaneV1, "delegated" | "service">; actingPrincipal?: PrincipalRefV1 }
  | undefined {
  if (row.credentialLane === "service") return { lane: "service" }
  if (!connectorVendor(row.type)?.delegatedCredentials) return undefined
  if (!readResolvedPrincipal(event.channelData)) return undefined
  return { lane: "delegated", actingPrincipal: connectorRequester(event) }
}
