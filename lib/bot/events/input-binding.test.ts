import { botInputStillMatches, resolveBotInputBinding } from "./input-binding"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { PluginBotTriggerDef } from "@/types/plugin/plugin-bot"

const trigger: PluginBotTriggerDef = {
  id: "in",
  kind: "event",
  source: "integration",
  types: ["opened"],
  inputCredentialSlot: "input",
}
const definition = {
  triggers: [trigger],
  requires: {
    credentials: [
      { id: "input", label: "Input" },
      { id: "output", label: "Output" },
    ],
  },
}
const installation = {
  credentialBindings: {
    input: { integrationAccountId: "a" },
    output: { integrationAccountId: "b" },
  },
}

it("keeps output credentials out of input routing and refuses wrong-source or missing slots", () => {
  expect(resolveBotInputBinding(installation, definition, trigger)).toMatchObject({
    kind: "bound",
    slotId: "input",
    integrationAccountId: "a",
  })
  expect(
    resolveBotInputBinding(
      { credentialBindings: { input: { adapterId: "chat" } } },
      definition,
      trigger
    )
  ).toEqual({ kind: "invalid" })
  expect(resolveBotInputBinding({ credentialBindings: {} }, definition, trigger)).toEqual({
    kind: "invalid",
  })
  expect(
    resolveBotInputBinding(installation, definition, { ...trigger, inputCredentialSlot: "missing" })
  ).toEqual({ kind: "invalid" })
})

it("supports explicit installation selection and fences accepted events after rebind", () => {
  const selected = { ...installation, triggerInputSlots: { in: "output" } }
  expect(resolveBotInputBinding(selected, definition, trigger)).toMatchObject({
    integrationAccountId: "b",
  })
  const event = {
    triggerId: "in",
    source: "integration",
    binding: { integrationAccountId: "a" },
  } as BotEventEnvelopeV1
  expect(botInputStillMatches(installation, definition, event)).toBe(true)
  expect(botInputStillMatches(selected, definition, event)).toBe(false)
})

it("allows one legacy account, refuses ambiguity, and preserves credential-free observers", () => {
  const legacy = { ...trigger, inputCredentialSlot: undefined }
  expect(resolveBotInputBinding(installation, { triggers: [legacy] }, legacy)).toEqual({
    kind: "invalid",
  })
  expect(
    resolveBotInputBinding(
      { credentialBindings: { old: { integrationAccountId: "a" } } },
      { triggers: [legacy] },
      legacy
    )
  ).toMatchObject({ integrationAccountId: "a" })
  expect(
    resolveBotInputBinding({ credentialBindings: {} }, { triggers: [legacy] }, legacy)
  ).toEqual({ kind: "unscoped" })
})
