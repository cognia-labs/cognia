import type { PetEvent } from "@/types/pet"
import { __resetTopicsForTesting, clearTopic, publishTopic } from "@/lib/runtime/topics"
import { wireConnectorSource } from "./connector-source"

beforeEach(() => __resetTopicsForTesting())

describe("wireConnectorSource", () => {
  it("emits inboundMessage for each inbound message the connectors announce", () => {
    const events: PetEvent[] = []
    const off = wireConnectorSource((e) => events.push({ ...e, at: 0 }))
    publishTopic("connectors.inbound", { seq: 1, at: 10 })
    publishTopic("connectors.inbound", { seq: 2, at: 20 })
    expect(events.map((e) => e.kind)).toEqual(["inboundMessage", "inboundMessage"])
    expect(events[0]).toMatchObject({ source: "connector", xp: 1 })
    off()
    publishTopic("connectors.inbound", { seq: 3, at: 30 })
    expect(events).toHaveLength(2)
  })

  it("does not replay the message already announced when it starts listening", () => {
    publishTopic("connectors.inbound", { seq: 5, at: 50 })
    const events: PetEvent[] = []
    wireConnectorSource((e) => events.push({ ...e, at: 0 }))
    publishTopic("connectors.inbound", { seq: 5, at: 50 })
    expect(events).toHaveLength(0)
    publishTopic("connectors.inbound", { seq: 6, at: 60 })
    expect(events).toHaveLength(1)
  })

  it("ignores the topic being withdrawn", () => {
    const events: PetEvent[] = []
    wireConnectorSource((e) => events.push({ ...e, at: 0 }))
    publishTopic("connectors.inbound", { seq: 1, at: 10 })
    clearTopic("connectors.inbound")
    expect(events).toHaveLength(1)
  })
})
