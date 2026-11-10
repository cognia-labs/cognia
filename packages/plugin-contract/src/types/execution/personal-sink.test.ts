import { decidePersonalSink } from "./personal-sink"
import { samePerson, type PersonalMarkV1, type PrincipalRefV1 } from "./acting-identity"

const owner: PrincipalRefV1 = { kind: "local-person" }
const peer: PrincipalRefV1 = {
  kind: "platform",
  platform: "lark",
  adapterId: "a",
  remoteUserId: "ou_peer",
}
const mark = (person: PrincipalRefV1): PersonalMarkV1 => ({ person, source: "read", markedAt: 1 })

it("allows untainted content at every sink", () => {
  for (const audience of [
    { kind: "person" as const, person: peer },
    { kind: "host-local" as const },
    { kind: "group" as const },
    { kind: "unknown" as const, label: "document" },
  ])
    expect(decidePersonalSink([], audience, samePerson)).toEqual({ outcome: "allow" })
})

it("allows only an exclusively matching person, including Host-local", () => {
  expect(decidePersonalSink([mark(owner)], { kind: "host-local" }, samePerson)).toEqual({
    outcome: "allow",
  })
  expect(decidePersonalSink([mark(peer)], { kind: "person", person: peer }, samePerson)).toEqual({
    outcome: "allow",
  })
  expect(
    decidePersonalSink([mark(peer)], { kind: "group", members: [peer] }, samePerson)
  ).toMatchObject({ outcome: "narrow", person: peer })
})

it("narrows a reply to one person, deduplicating with the Host equivalence", () => {
  const equal = (a: PrincipalRefV1, b: PrincipalRefV1) =>
    samePerson(a, b) || (a === owner && b === peer) || (a === peer && b === owner)
  expect(decidePersonalSink([mark(owner), mark(peer)], { kind: "group" }, equal)).toEqual({
    outcome: "narrow",
    person: owner,
  })
})

it("withholds unknown audiences and multiple persons without granting disclosure", () => {
  expect(
    decidePersonalSink([mark(owner)], { kind: "unknown", label: "doc" }, samePerson)
  ).toMatchObject({ outcome: "withhold", persons: [owner] })
  expect(
    decidePersonalSink([mark(owner), mark(peer)], { kind: "group" }, samePerson)
  ).toMatchObject({ outcome: "withhold", persons: [owner, peer] })
})
