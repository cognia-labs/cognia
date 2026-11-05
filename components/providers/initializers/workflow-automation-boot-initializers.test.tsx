import { render } from "@testing-library/react"

jest.mock("./code-adoption-tracker-initializer", () => ({
  CodeAdoptionTrackerInitializer: () => <span data-boot="code-adoption" />,
}))
jest.mock("./background-task-initializer", () => ({
  BackgroundTaskInitializer: () => <span data-boot="background" />,
}))
jest.mock("./goal-verification-initializer", () => ({
  GoalVerificationInitializer: () => <span data-boot="goal-verification" />,
}))
jest.mock("./automation-policy-initializer", () => ({
  AutomationPolicyInitializer: () => <span data-boot="automation-policy" />,
}))
jest.mock("./a2ui-surface-persistence-initializer", () => ({
  A2UISurfacePersistenceInitializer: () => <span data-boot="a2ui" />,
}))
jest.mock("@/components/scheduler/scheduler-initializer", () => ({
  SchedulerInitializer: () => <span data-boot="scheduler" />,
}))
jest.mock("@/components/providers/workflow-runtime-provider", () => ({
  WorkflowRuntimeProvider: () => <span data-boot="workflow" />,
}))
// The real one renders null; stubbed so a group that dropped its module
// runtimes (ADR-0250 §14) fails here.
jest.mock("./module-runtime-host", () => ({
  ModuleRuntimeHost: ({ boot }: { boot?: string }) => <span data-boot={`modules:${boot}`} />,
}))
const mockMarkReady = jest.fn()
jest.mock("@/lib/boot/capabilities", () => ({
  markBootCapabilityReady: (...args: unknown[]) => mockMarkReady(...args),
}))

import { WorkflowAutomationBootInitializers } from "./workflow-automation-boot-initializers"

it("mounts workflow automation in deterministic order and reports readiness", () => {
  const { container } = render(<WorkflowAutomationBootInitializers />)
  expect(
    Array.from(container.querySelectorAll("[data-boot]")).map((node) =>
      node.getAttribute("data-boot")
    )
  ).toEqual([
    "background",
    "goal-verification",
    "automation-policy",
    "code-adoption",
    "a2ui",
    "scheduler",
    "workflow",
    "modules:workflow-automation",
  ])
  expect(mockMarkReady).toHaveBeenCalledWith("workflow-automation")
})
