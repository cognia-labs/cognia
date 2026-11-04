/** An error carrying a JSON-RPC error code, used by `onServerRequest`. */
export class JsonRpcMethodError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message)
    this.name = "JsonRpcMethodError"
  }
}
