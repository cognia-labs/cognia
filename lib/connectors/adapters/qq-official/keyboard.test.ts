import { validateQQKeyboard } from "./keyboard"

const button = (type = 1) => ({
  id: "b",
  render_data: { label: "Confirm", style: 1 },
  action: { type, data: type === 0 ? "https://example.org" : "/confirm", permission: { type: 2 } },
})
const keyboard = (value: unknown = button()) => ({ content: { rows: [{ buttons: [value] }] } })

it.each(["group", "c2c"] as const)(
  "validates native %s link/callback/command and template keyboards",
  (scene) => {
    for (const type of [0, 1, 2])
      expect(
        validateQQKeyboard(keyboard(button(type)), scene).content?.rows[0]?.buttons[0]?.action.type
      ).toBe(type)
    expect(validateQQKeyboard({ id: "template" }, scene)).toEqual({ id: "template" })
  }
)

it.each([
  {},
  { id: "template", content: { rows: [] } },
  { content: { rows: [] } },
  keyboard({ ...button(), render_data: { label: "longer-than-ten" } }),
  keyboard({ ...button(), action: { type: 9, data: "x", permission: { type: 2 } } }),
  keyboard({
    ...button(),
    action: { type: 0, data: "javascript:alert(1)", permission: { type: 2 } },
  }),
  keyboard({
    ...button(),
    action: { type: 0, data: "https://user:pass@example.org", permission: { type: 2 } },
  }),
  keyboard({
    ...button(),
    action: { type: 1, data: "x", permission: { type: 0, specify_user_ids: [] } },
  }),
  { content: { rows: [{ buttons: [button(), button()] }] } },
  { content: { rows: new Array(6).fill({ buttons: [button()] }) } },
])("rejects malformed or unsafe keyboard %j", (value) => {
  expect(() => validateQQKeyboard(value, "group")).toThrow()
})

it("keeps automatic command send and image-picker anchors C2C-only", () => {
  const value = keyboard({
    ...button(2),
    action: { ...button(2).action, enter: true, reply: true, anchor: 1 },
  })
  expect(() => validateQQKeyboard(value, "group")).toThrow(/C2C/)
  expect(validateQQKeyboard(value, "c2c").content?.rows[0]?.buttons[0]?.action).toMatchObject({
    type: 2,
    enter: true,
    reply: true,
    anchor: 1,
  })
})
