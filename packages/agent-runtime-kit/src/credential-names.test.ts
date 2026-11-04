import { looksSecret } from "./credential-names"
it.each(["OPENAI_API_KEY", "authorization", "SESSION_ID", "WEBHOOK_URL"])(
  "classifies %s as credential-bearing",
  (name) => expect(looksSecret(name)).toBe(true)
)
it("leaves ordinary environment names public", () => expect(looksSecret("TERM")).toBe(false))
