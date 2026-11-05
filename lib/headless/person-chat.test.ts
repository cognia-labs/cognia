import { initializePersonChat, personChatCapability, personHostBootedAt } from "./person-chat"

afterEach(() => initializePersonChat("brain", {}))

it("enables only a person brain with the exact Host flag, captured at startup", () => {
  const env = { COGNIA_PERSON_CHAT: "tool-less" }
  initializePersonChat("person-brain", env)
  env.COGNIA_PERSON_CHAT = "none"
  expect(personChatCapability()).toEqual({ chat: "tool-less", execution: "none" })
  initializePersonChat("brain", { COGNIA_PERSON_CHAT: "tool-less" })
  expect(personChatCapability()).toEqual({ chat: "none", execution: "none" })
  initializePersonChat("person-brain", {})
  expect(personChatCapability()).toEqual({ chat: "none", execution: "none" })
})

it("p6e reads sandboxed execution only from a person brain with the exact Host value", () => {
  initializePersonChat("person-brain", { COGNIA_PERSON_EXECUTION: "sandboxed" })
  expect(personChatCapability()).toEqual({ chat: "none", execution: "sandboxed" })
  initializePersonChat("person-brain", {
    COGNIA_PERSON_CHAT: "tool-less",
    COGNIA_PERSON_EXECUTION: "sandboxed",
  })
  expect(personChatCapability()).toEqual({ chat: "tool-less", execution: "sandboxed" })
  initializePersonChat("brain", { COGNIA_PERSON_EXECUTION: "sandboxed" })
  expect(personChatCapability().execution).toBe("none")
  initializePersonChat("person-brain", { COGNIA_PERSON_EXECUTION: "yes" })
  expect(personChatCapability().execution).toBe("none")
})

it("adr0253 reads the Host boot time only from a person brain, as a plain positive integer", () => {
  initializePersonChat("person-brain", { COGNIA_HOST_BOOTED_AT: "1767225600000" })
  expect(personHostBootedAt()).toBe(1767225600000)
  initializePersonChat("brain", { COGNIA_HOST_BOOTED_AT: "1767225600000" })
  expect(personHostBootedAt()).toBeNull()
  for (const value of ["", "0", "-5", "1.5", "1e12", " 17", "99999999999999999"]) {
    initializePersonChat("person-brain", { COGNIA_HOST_BOOTED_AT: value })
    expect(personHostBootedAt()).toBeNull()
  }
  initializePersonChat("person-brain", {})
  expect(personHostBootedAt()).toBeNull()
})
