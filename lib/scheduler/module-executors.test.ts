jest.mock("./task-scheduler", () => ({ registerTaskExecutor: jest.fn() }))

import { loggers } from "@cognia/logging"
import type { ModuleTaskExecutorsEntry } from "@/lib/modules/manifest-types"
import { MODULE_TASK_EXECUTORS } from "@/lib/modules/generated/task-executors"
import type { TaskExecutor } from "./task-scheduler"
import { registerTaskExecutor } from "./task-scheduler"
import { __resetModuleTaskExecutorsForTesting, moduleTaskExecutorOwners } from "./module-executors"

const pushExecutor: TaskExecutor = async () => ({ success: true })
const digestExecutor: TaskExecutor = async () => ({ success: true })

function entry(
  types: ModuleTaskExecutorsEntry["types"],
  load: ModuleTaskExecutorsEntry["load"],
  stage: ModuleTaskExecutorsEntry["stage"] = "stable",
  module = "connectors"
): ModuleTaskExecutorsEntry {
  return { module, stage, types, load }
}

let errorLog: jest.SpyInstance

beforeEach(() => {
  __resetModuleTaskExecutorsForTesting()
  jest.mocked(registerTaskExecutor).mockClear()
  errorLog = jest.spyOn(loggers.scheduler, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  errorLog.mockRestore()
})

describe("moduleTaskExecutorOwners", () => {
  it("gives every declared type an owner that registers the module's executors", async () => {
    const load = jest.fn(async () => ({
      taskExecutors: { "im-push": pushExecutor, test: digestExecutor },
    }))
    const owners = moduleTaskExecutorOwners([entry(["im-push", "test"], load)])
    expect(Object.keys(owners).sort()).toEqual(["im-push", "test"])
    expect(owners["im-push"]).toBe(owners.test)
    await owners["im-push"]!()
    expect(registerTaskExecutor).toHaveBeenCalledWith("im-push", pushExecutor)
    expect(registerTaskExecutor).toHaveBeenCalledWith("test", digestExecutor)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it("loads a module's file once, also for concurrent owners", async () => {
    const load = jest.fn(async () => ({ taskExecutors: { "im-push": pushExecutor } }))
    const owners = moduleTaskExecutorOwners([entry(["im-push"], load)])
    await Promise.all([owners["im-push"]!(), owners["im-push"]!()])
    await owners["im-push"]!()
    expect(load).toHaveBeenCalledTimes(1)
    expect(registerTaskExecutor).toHaveBeenCalledTimes(1)
  })

  it("rejects when the file fails to load and tries again next time", async () => {
    const load = jest
      .fn<ReturnType<ModuleTaskExecutorsEntry["load"]>, []>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValueOnce({ taskExecutors: { "im-push": pushExecutor } })
    const owners = moduleTaskExecutorOwners([entry(["im-push"], load)])
    await expect(owners["im-push"]!()).rejects.toThrow("chunk failed")
    await owners["im-push"]!()
    expect(load).toHaveBeenCalledTimes(2)
    expect(registerTaskExecutor).toHaveBeenCalledWith("im-push", pushExecutor)
  })

  it("logs a declared type the file does not provide and leaves it unregistered", async () => {
    const load = jest.fn(async () => ({ taskExecutors: { "im-push": pushExecutor } }))
    const owners = moduleTaskExecutorOwners([entry(["im-push", "test"], load)])
    await owners.test!()
    expect(registerTaskExecutor).toHaveBeenCalledTimes(1)
    expect(registerTaskExecutor).not.toHaveBeenCalledWith("test", expect.anything())
    expect(errorLog).toHaveBeenCalledWith(
      "task executors a module declares were not provided",
      expect.objectContaining({ module: "connectors", missing: ["test"] })
    )
  })

  it("logs and skips an executor the module provides but does not declare", async () => {
    const load = jest.fn(async () => ({
      taskExecutors: { "im-push": pushExecutor, test: digestExecutor },
    }))
    const owners = moduleTaskExecutorOwners([entry(["im-push"], load)])
    await owners["im-push"]!()
    expect(registerTaskExecutor).not.toHaveBeenCalledWith("test", expect.anything())
    expect(errorLog).toHaveBeenCalledWith(
      "task executors a module provides but does not declare",
      expect.objectContaining({ module: "connectors", undeclared: ["test"] })
    )
  })

  it("gives an experimental module's types no owner", () => {
    const load = jest.fn(async () => ({ taskExecutors: { "im-push": pushExecutor } }))
    expect(moduleTaskExecutorOwners([entry(["im-push"], load, "experimental")])).toEqual({})
    expect(load).not.toHaveBeenCalled()
  })

  it("reads the generated registry by default, where the connectors own im-push", () => {
    expect(
      MODULE_TASK_EXECUTORS.find((candidate) => candidate.types.includes("im-push"))?.module
    ).toBe("connectors")
    expect(Object.keys(moduleTaskExecutorOwners())).toContain("im-push")
  })
})
