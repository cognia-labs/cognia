// QQ Official Bot is the target. NapCat is only a read-only human-client
// observer; no Official Bot credential or platform send API is used here.
import { createQQHistoryDriver } from "./onebot.mjs"

export function createQQOfficialDriver({ values, ...options }) {
  const { conversationKind = "group", targetConversationId, targetBotUin, driverUserUin } = values
  if (!["group", "c2c"].includes(conversationKind))
    throw new Error("QQ Official conversation kind must be group or c2c")
  if (String(driverUserUin) === String(targetBotUin))
    throw new Error("QQ Official human observer must differ from the target bot")
  if (conversationKind === "c2c" && String(targetConversationId) !== String(targetBotUin))
    throw new Error("QQ Official C2C peer must match the target bot UIN")
  const driver = createQQHistoryDriver({
    ...options,
    values,
    platform: "qq-official",
    observerUin: driverUserUin,
    conversationKind,
    conversationId: targetConversationId,
    quoteNeedsMention: conversationKind === "group",
  })
  return {
    ...driver,
    acceptanceScope: {
      kind: "client-visible-text-smoke",
      conversationKind,
      identityBasis: "operator-supplied-client-UIN",
      excludes: [
        "official-app-identity-mapping",
        "stream-completion",
        "host-control",
        "provider-receipt-recovery",
      ],
    },
  }
}
