import assert from "node:assert/strict"
import { test } from "node:test"
import { invitationFromPairJson, pairArguments } from "./compose-pair.mjs"

test("an issued relay or direct invitation is returned as is", () => {
  for (const invitation of ["cgnp4|eyJiYXNlIjoiaHR0cHMifQ", "cgnp3|eyJiYXNlIjoiaHR0cHMifQ"]) {
    const stdout = `\n${JSON.stringify({ status: "issued", invitation, hasRelay: true, expiresAtMs: 1 })}\n`
    assert.equal(invitationFromPairJson(stdout), invitation)
  }
})

test("a refusal fails with the Host's reason, never an empty payload", () => {
  const stdout = JSON.stringify({
    status: "refused",
    cause: "not_running",
    message: "no relay invitation: connection refused",
  })
  assert.throws(
    () => invitationFromPairJson(stdout),
    /refused \(not_running\): no relay invitation/
  )
  assert.throws(() => invitationFromPairJson(""), /no JSON answer/)
  assert.throws(
    () => invitationFromPairJson(JSON.stringify({ status: "issued", invitation: "cgnp9|x" })),
    /without a usable invitation/
  )
})

test("pair always runs as JSON and direct, with caller flags last", () => {
  assert.deepEqual(pairArguments("cognia-server", "e2e", ["--tenant-id", "t"]), [
    "compose",
    "exec",
    "-T",
    "cognia-server",
    "cognia-server",
    "pair",
    "--json",
    "--direct",
    "--device-name",
    "e2e",
    "--tenant-id",
    "t",
  ])
  assert.throws(() => pairArguments("", "e2e"), /usage/)
})
