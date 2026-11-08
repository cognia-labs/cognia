import {
  namespacedCallbackAction,
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
