/**
 * Replays a captured A2UI surface (a message segment's `content`) as the
 * server messages that rebuild it: create, components, the data model
 * (replacing, not merging) and ready. The a2ui module's generator and the
 * plugin host's agent turn (which writes the surfaces a turn produced back
 * into its transcript) share it.
 */

import type {
  A2UIComponent,
  A2UIComputedFields,
  A2UIServerMessage,
} from "@cognia/plugin-contract/types/a2ui/schema"
import type { A2UISegmentContent } from "@cognia/plugin-contract/types/connectors/segment"
import { isA2UIComputedFields } from "./computed"

export function segmentToMessages(
  surfaceId: string,
  content: A2UISegmentContent
): A2UIServerMessage[] {
  const components = Object.values(content.components) as A2UIComponent[]
  return [
    {
      type: "createSurface",
      surfaceId,
      surfaceType: content.surfaceType ?? "inline",
      title: content.title,
      catalogId: content.catalogId,
      widget: content.widget,
      // Validated where it was captured; re-checked here because the segment
      // type is loose (`Record<string, unknown>`).
      ...(isA2UIComputedFields(content.computed)
        ? { computed: content.computed as A2UIComputedFields }
        : {}),
    },
    { type: "updateComponents", surfaceId, components },
    { type: "dataModelUpdate", surfaceId, data: content.dataModel, merge: false },
    { type: "surfaceReady", surfaceId },
  ]
}
