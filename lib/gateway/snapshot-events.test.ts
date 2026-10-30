import { notifyGatewaySnapshotChanged, subscribeGatewaySnapshotChanged } from "./snapshot-events"

it("republishes subscribed snapshots and stops after cleanup", () => {
  const listener = jest.fn()
  const dispose = subscribeGatewaySnapshotChanged(listener)
  notifyGatewaySnapshotChanged()
  expect(listener).toHaveBeenCalledTimes(1)
  dispose()
  notifyGatewaySnapshotChanged()
  expect(listener).toHaveBeenCalledTimes(1)
})

it("does not let a failed subscriber hide a saved update from other publishers", () => {
  const disposeFailure = subscribeGatewaySnapshotChanged(() => {
    throw new Error("test")
  })
  const listener = jest.fn()
  const dispose = subscribeGatewaySnapshotChanged(listener)
  expect(() => notifyGatewaySnapshotChanged()).not.toThrow()
  expect(listener).toHaveBeenCalledTimes(1)
  disposeFailure()
  dispose()
})
