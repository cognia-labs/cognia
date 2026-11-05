import { releaseSettledSubmissionAttachments } from "./attachment-release"

jest.mock("@/lib/db/session-attachment-uploads", () => ({
  ...jest.requireActual("@/lib/db/session-attachment-uploads"),
  consumeAttachmentRefs: jest.fn(),
}))
jest.mock("@/lib/db/work-submissions", () => ({ getWorkInputBatch: jest.fn() }))

const attachment = (assetId: string) => ({
  assetId,
  digest: "a".repeat(64),
  mediaType: "image/png",
  size: 3,
  fileName: "shot.png",
})

describe("releaseSettledSubmissionAttachments", () => {
  it("consumes only the staged uploads the settled turn's frozen input names", async () => {
    const consume = jest.fn(async () => undefined)
    const getBatch = jest.fn(async () => ({
      attachments: [attachment("cognia-upload:upl_1"), attachment("asset-elsewhere")],
    }))
    await releaseSettledSubmissionAttachments("work:hoststate:a1", {
      getBatch: getBatch as never,
      consume,
    })
    expect(getBatch).toHaveBeenCalledWith("work:hoststate:a1")
    expect(consume).toHaveBeenCalledWith(["cognia-upload:upl_1"])
  })

  it("does nothing for a turn without uploads or without a frozen input", async () => {
    const consume = jest.fn(async () => undefined)
    await releaseSettledSubmissionAttachments("s", {
      getBatch: (async () => ({ attachments: [] })) as never,
      consume,
    })
    await releaseSettledSubmissionAttachments("s", {
      getBatch: (async () => undefined) as never,
      consume,
    })
    expect(consume).not.toHaveBeenCalled()
  })

  it("never throws: the turn is already sealed", async () => {
    const onError = jest.fn()
    await expect(
      releaseSettledSubmissionAttachments("s", {
        getBatch: (async () => {
          throw new Error("db closed")
        }) as never,
        onError,
      })
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(new Error("db closed"))
  })
})
