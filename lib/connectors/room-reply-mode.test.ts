/** @jest-environment node */
import type { InboundActivationPolicy } from "@/types/connectors/policy"
import {
  activationPolicyForReplyMode,
  imRoomReplyMode,
  replyModeOfActivationPolicy,
} from "./room-reply-mode"

const POLICIES: InboundActivationPolicy[] = [
  "off",
  "direct_only",
  "mention_each",
  "mention_activates",
  "always",
]

describe("replyModeOfActivationPolicy", () => {
  it("reads every policy as the mode it behaves as, by scope", () => {
    expect(POLICIES.map((p) => replyModeOfActivationPolicy(p, "group"))).toEqual([
      "asleep",
      "asleep",
      "mention_only",
      "mention_only",
      "auto",
    ])
    expect(POLICIES.map((p) => replyModeOfActivationPolicy(p, "thread"))).toEqual([
      "asleep",
      "asleep",
      "mention_only",
      "auto",
      "auto",
    ])
  })
})

describe("imRoomReplyMode", () => {
  it("prefers the conversation's policy, then the adapter's, then its legacy strategy", () => {
    expect(
      imRoomReplyMode({
        adapter: { inboundActivationPolicy: "always" },
        override: { inboundActivationPolicy: "off" },
        scope: "group",
      })
    ).toBe("asleep")
    expect(
      imRoomReplyMode({
        adapter: { inboundActivationPolicy: "always" },
        override: null,
        scope: "group",
      })
    ).toBe("auto")
    expect(imRoomReplyMode({ adapter: {}, override: undefined, scope: "group" })).toBe(
      "mention_only"
    )
  })
})

describe("activationPolicyForReplyMode", () => {
  const adapterAlways = { inboundActivationPolicy: "always" as const }
  const adapterMention = { inboundActivationPolicy: "mention_each" as const }

  it("writes off and mention_each for asleep and mention-only", () => {
    const input = { adapter: adapterAlways, override: null, scope: "group" as const }
    expect(activationPolicyForReplyMode("asleep", input)).toBe("off")
    expect(activationPolicyForReplyMode("mention_only", input)).toBe("mention_each")
  })

  it("keeps a finer auto policy, follows an auto adapter, and otherwise writes always", () => {
    expect(
      activationPolicyForReplyMode("auto", {
        adapter: adapterMention,
        override: { inboundActivationPolicy: "mention_activates" },
        scope: "thread",
      })
    ).toBe("mention_activates")
    expect(
      activationPolicyForReplyMode("auto", {
        adapter: adapterAlways,
        override: { inboundActivationPolicy: "off" },
        scope: "group",
      })
    ).toBeUndefined()
    expect(
      activationPolicyForReplyMode("auto", {
        adapter: adapterMention,
        override: { inboundActivationPolicy: "off" },
        scope: "group",
      })
    ).toBe("always")
    // In a plain group, `mention_activates` is not auto, so it is not kept.
    expect(
      activationPolicyForReplyMode("auto", {
        adapter: adapterMention,
        override: { inboundActivationPolicy: "mention_activates" },
        scope: "group",
      })
    ).toBe("always")
  })

  it("round-trips: what it writes reads back as the mode chosen", () => {
    for (const adapter of [adapterAlways, adapterMention, {}]) {
      for (const scope of ["group", "thread", "channel"] as const) {
        for (const current of [undefined, ...POLICIES]) {
          for (const mode of ["auto", "mention_only", "asleep"] as const) {
            const input = {
              adapter,
              override: current ? { inboundActivationPolicy: current } : null,
              scope,
            }
            const written = activationPolicyForReplyMode(mode, input)
            expect(
              imRoomReplyMode({
                adapter,
                override: written ? { inboundActivationPolicy: written } : null,
                scope,
              })
            ).toBe(mode)
          }
        }
      }
    }
  })
})
