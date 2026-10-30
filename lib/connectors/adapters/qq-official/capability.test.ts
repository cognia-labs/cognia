import { QQ_OFFICIAL_A2UI_CAPABILITY, QQ_OFFICIAL_CAPS } from "./capability"
import { A2UI_COMPONENT_KINDS } from "@/types/connectors/capability"

describe("qq-official capability", () => {
  it("declares native Markdown, media and files and native button projection", () => {
    expect(QQ_OFFICIAL_CAPS).toEqual(
      expect.arrayContaining([
        "links.create",
        "events.interaction",
        "events.delivery-status",
        "assets.manage",
        "menus.manage",
        "commands.manage",
        "chat.moderation",
        "chat.join.requests",
        "chat.join.policies",
        "send.proactive",
        "send.reengagement",
        "send.image.verify",
        "send.mention.all",
        "send.button.policy",
      ])
    )
    expect(QQ_OFFICIAL_CAPS).toContain("send.text")
    expect(QQ_OFFICIAL_CAPS).toContain("send.reply")
    expect(QQ_OFFICIAL_CAPS).toContain("send.markdown")
    expect(QQ_OFFICIAL_CAPS).toEqual(
      expect.arrayContaining(["send.image", "send.video", "send.voice"])
    )
    expect(QQ_OFFICIAL_CAPS).toContain("send.file")
    expect(QQ_OFFICIAL_CAPS).toContain("send.a2ui")
  })

  it("advertises only implemented native components and keeps other widgets as fallback", () => {
    for (const kind of A2UI_COMPONENT_KINDS) {
      expect(QQ_OFFICIAL_A2UI_CAPABILITY[kind]).toBe(
        ["Button", "ButtonGroup", "Text", "Row", "Column", "Card"].includes(kind)
          ? "native"
          : "fallback"
      )
    }
  })
})
