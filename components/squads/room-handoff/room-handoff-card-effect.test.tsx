import { render } from "@testing-library/react"
import {
  clearAllToolResultRenderers,
  getToolResultRenderer,
} from "@/lib/plugin/api/tool-result-renderers"

jest.mock("./room-handoff-card", () => ({
  RoomHandoffCard: function RoomHandoffCard() {
    return null
  },
}))

import RoomHandoffCardEffect, { ROOM_HANDOFF_CARD_OWNER } from "./room-handoff-card-effect"

afterEach(() => clearAllToolResultRenderers())

it("registers the card for both name forms while mounted, opening its row", () => {
  const { unmount } = render(<RoomHandoffCardEffect />)
  for (const name of ["room_handoff_to_squad", "mcp__cognia-plugin-tools__room_handoff_to_squad"]) {
    expect(getToolResultRenderer(name)).toMatchObject({
      pluginId: ROOM_HANDOFF_CARD_OWNER,
      opensRow: true,
    })
  }
  unmount()
  expect(getToolResultRenderer("room_handoff_to_squad")).toBeUndefined()
})
