import { buildLarkClosedApprovalSegment } from "./approval-card"

it.each([
  "approved",
  "denied",
  "expired",
  "processed",
  "failed",
  "answered",
  "skipped",
  "cancelled",
] as const)("removes every action in a %s card", (state) => {
  const segment = buildLarkClosedApprovalSegment(state)
  expect(JSON.stringify(segment)).not.toContain('"button"')
  expect(JSON.stringify(segment)).toContain('"schema":"2.0"')
})
it("titles each closed state with its own icon and colour", () => {
  const header = (state: Parameters<typeof buildLarkClosedApprovalSegment>[0]) =>
    (
      buildLarkClosedApprovalSegment(state) as {
        card: { payload: { header: Record<string, unknown> } }
      }
    ).card.payload.header
  expect(header("answered")).toMatchObject({
    title: { content: "已回答" },
    template: "green",
    icon: { token: "succeed_filled" },
  })
  expect(header("skipped")).toMatchObject({ title: { content: "已跳过" } })
  expect(header("cancelled")).toMatchObject({
    title: { content: "已停止" },
    template: "orange",
    icon: { token: "stop_outlined" },
  })
})
it("keeps the detail's markdown but disarms a mention in it", () => {
  const text = JSON.stringify(buildLarkClosedApprovalSegment("answered", "**Q** <at id=all></at>"))
  expect(text).toContain("**Q**")
  expect(text).not.toMatch(/<at\b/)
})
it("includes the optional detail above the closed notice", () => {
  const withDetail = JSON.stringify(
    buildLarkClosedApprovalSegment("answered", "**Q**\n> Selected: A")
  )
  expect(withDetail).toContain("Selected: A")
  const blank = JSON.stringify(buildLarkClosedApprovalSegment("answered", "   "))
  expect(blank).not.toContain("> ")
})
