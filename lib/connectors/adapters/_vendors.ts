/**
 * The connector vendors that contribute to the IM framework (ADR-0250 §14).
 *
 * A list and nothing else: it may import only `./<vendor>/contribution.ts`
 * files, which `pnpm audit:modules` (G8) enforces. Framework code reads it
 * through `lib/connectors/vendor-contribution.ts`. Vendors without a
 * contribution keep their entries in the framework's tables until they move.
 */

import type { ConnectorVendorContribution } from "@/lib/connectors/vendor-contribution"
import { larkContribution } from "./lark/contribution"

export const CONNECTOR_VENDORS: readonly ConnectorVendorContribution[] = [larkContribution]
