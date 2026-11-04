import { JsonRpcMethodError } from "./json-rpc-error"
import { JsonRpcMethodError as LegacyError } from "./json-rpc-peer"
it("preserves error identity across the data-only and peer entries", () => {
  const error = new JsonRpcMethodError(-32602, "invalid input")
  expect(error).toBeInstanceOf(Error)
  expect(error).toBeInstanceOf(LegacyError)
  expect(error).toMatchObject({
    code: -32602,
    name: "JsonRpcMethodError",
    message: "invalid input",
  })
})
