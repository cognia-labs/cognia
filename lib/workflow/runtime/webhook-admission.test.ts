jest.mock("./tauri-bridge", () => ({ respondToWebhook: jest.fn() }))

import type { TriggerEvent } from "@/types/workflow/visual"
import { WorkflowAdmissionError } from "./execution-authority"
import {
  WEBHOOK_HANDOFF_ID_HEADER,
  WEBHOOK_RUN_ID_HEADER,
  webhookAdmissionAck,
  webhookAdmissionIdOf,
  webhookAdmittedReply,
  webhookHoldsResponse,
  webhookRejectedReply,
} from "./webhook-admission"

function webhook(payload: Record<string, unknown>): TriggerEvent {
  return { workflowId: "wf", kind: "trigger.webhook", triggerId: "t", originAt: 1, payload }
}

describe("webhook admission receipts", () => {
  it("reads the admission and response correlation ids only from webhook events", () => {
    expect(webhookAdmissionIdOf(webhook({ admissionId: "wha_1" }))).toBe("wha_1")
    expect(webhookAdmissionIdOf(webhook({ admissionId: "" }))).toBeUndefined()
    expect(
      webhookAdmissionIdOf({ ...webhook({ admissionId: "wha_1" }), kind: "trigger.cron" })
    ).toBeUndefined()
    expect(webhookHoldsResponse(webhook({ correlationId: "whr_1" }))).toBe(true)
    expect(webhookHoldsResponse(webhook({ admissionId: "wha_1" }))).toBe(false)
    expect(
      webhookHoldsResponse({ ...webhook({ correlationId: "whr_1" }), kind: "trigger.cron" })
    ).toBe(false)
  })

  it("acknowledges a run or a handoff with a 2xx receipt header", () => {
    expect(webhookAdmittedReply({ kind: "run", runId: "run_1" })).toEqual({
      status: 202,
      body: "",
      headers: { [WEBHOOK_RUN_ID_HEADER]: "run_1" },
    })
    expect(
      webhookAdmittedReply({ kind: "handoff", dispatchId: "hdq_1", targetRef: "host-b" })
    ).toEqual({ status: 202, body: "", headers: { [WEBHOOK_HANDOFF_ID_HEADER]: "hdq_1" } })
  })

  it.each([
    ["deployment-not-found", 404],
    ["scope-denied", 403],
    ["input-schema-violation", 422],
    ["trigger-binding-invalid", 409],
    ["dependency-not-deployed", 409],
  ])("maps the %s refusal to HTTP %i with a JSON body", (code, status) => {
    const reply = webhookRejectedReply(new WorkflowAdmissionError(code, `refused: ${code}`))
    expect(reply.status).toBe(status)
    expect(reply.headers["content-type"]).toBe("application/json")
    expect(reply.headers["retry-after"]).toBeUndefined()
    expect(JSON.parse(reply.body)).toEqual({ error: `refused: ${code}`, code })
  })

  it("asks the sender to retry when the workflow is at its concurrency limit", () => {
    const reply = webhookRejectedReply(
      new WorkflowAdmissionError("workflow-concurrency-limit", "busy")
    )
    expect(reply.status).toBe(503)
    expect(reply.headers["retry-after"]).toBe("5")
  })

  it("answers an unexpected failure with 503 and does not leak its message", () => {
    const reply = webhookRejectedReply(new Error("disk I/O error at /secret/path"))
    expect(reply.status).toBe(503)
    expect(reply.headers["retry-after"]).toBe("5")
    expect(reply.body).not.toContain("/secret/path")
  })

  it("sends exactly one acknowledgement per event, the first outcome", async () => {
    const respond = jest.fn().mockResolvedValue(true)
    const ack = webhookAdmissionAck(webhook({ admissionId: "wha_7" }), respond)!
    await ack.admitted({ kind: "run", runId: "run_7" })
    await ack.rejected(new Error("thrown by the run after admission"))
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith(
      "wha_7",
      webhookAdmittedReply({ kind: "run", runId: "run_7" })
    )
  })

  it("has nothing to acknowledge for a non-webhook event or a failed IPC", async () => {
    expect(webhookAdmissionAck({ ...webhook({}), kind: "trigger.cron" })).toBeUndefined()
    const respond = jest.fn().mockRejectedValue(new Error("native plane down"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const ack = webhookAdmissionAck(webhook({ admissionId: "wha_8" }), respond)!
    await expect(ack.rejected(new Error("x"))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
