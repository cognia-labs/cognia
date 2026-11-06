// Google Docs' member of the `docs-provider` collection port
// (`types/modules/ports/docs-provider.ts`, ADR-0250 §14). The framework in
// `lib/docs-providers/` loads it with the other members and registers it;
// loading it also registers Google's OAuth deep-link completion.

import type { DocsProviderPort } from "@/types/modules/ports/docs-provider"
import { googleDocsProvider } from "./provider"

export const port: DocsProviderPort = googleDocsProvider
