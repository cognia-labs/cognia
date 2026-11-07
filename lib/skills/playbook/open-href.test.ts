import { playbookWorkflowHref } from "./open-href"

describe("playbookWorkflowHref", () => {
  it("points the workflow editor at the skill", () => {
    expect(playbookWorkflowHref("change-review")).toBe("/workflows/editor?playbook=change-review")
  })

  it("encodes ids that are not URL-safe", () => {
    expect(playbookWorkflowHref("cognia-playbooks:review & fix")).toBe(
      "/workflows/editor?playbook=cognia-playbooks%3Areview%20%26%20fix"
    )
  })
})
