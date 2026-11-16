import {
  namespacedCallbackAction,
  ROOM_HANDOFF_CONFIRM_PREFIX,
  ROOM_HANDOFF_DECLINE_PREFIX,
  SKILL_CANCEL_PREFIX,
  SKILL_INVOKE_PREFIX,
} from "./callback-prefixes"
it("keeps deferred skill confirmation and cancellation distinct across wire-id callbacks", () => {
  expect(namespacedCallbackAction(`${SKILL_INVOKE_PREFIX}im.manage_resource:request`)).toBe(
    "approve"
  )
  expect(namespacedCallbackAction(`${SKILL_CANCEL_PREFIX}im.manage_resource:request`)).toBe(
    "cancel"
  )
  expect(namespacedCallbackAction("skill_cancelled:request")).toBeUndefined()
  expect(namespacedCallbackAction({ action: "approve" })).toBeUndefined()
})

it("maps the IM room hand-off card's buttons to the wire verbs", () => {
  expect(namespacedCallbackAction(`${ROOM_HANDOFF_CONFIRM_PREFIX}ab12cd34.0`)).toBe("approve")
  expect(namespacedCallbackAction(`${ROOM_HANDOFF_DECLINE_PREFIX}ab12cd34`)).toBe("cancel")
})
