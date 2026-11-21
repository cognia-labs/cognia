import { workflowRunHref } from "./run-href"

describe("workflowRunHref", () => {
  it("targets the static run-detail route with query parameters", () => {
    expect(workflowRunHref("wf_1", "run_1")).toBe("/workflows/run?id=wf_1&runId=run_1")
  })

  it("encodes ids that are not URL-safe", () => {
    const href = workflowRunHref("__team__:a b", "run/1&x")
    expect(href).toBe("/workflows/run?id=__team__%3Aa%20b&runId=run%2F1%26x")
    const query = new URLSearchParams(href.split("?")[1])
    expect(query.get("id")).toBe("__team__:a b")
    expect(query.get("runId")).toBe("run/1&x")
  })
})
