import { TRANSCRIPT_ACTIVITY_METADATA_KEY, transcriptActivityOf } from "./turn-activity"

const activity = { toolCount: 2, failedCount: 0, reasoningCount: 1, sourceCount: 0, tools: [] }

describe("transcriptActivityOf", () => {
  it("reads a well-formed stamp", () => {
    const stamp = { activity, turnKey: "t", revision: 3, detailRevision: 9 }
    expect(transcriptActivityOf({ metadata: { [TRANSCRIPT_ACTIVITY_METADATA_KEY]: stamp } })).toBe(
      stamp
    )
  })

  it("is null for a message without one, or with a malformed one", () => {
    expect(transcriptActivityOf({})).toBeNull()
    expect(transcriptActivityOf({ metadata: { sessionId: "s" } })).toBeNull()
    expect(
      transcriptActivityOf({
        metadata: { [TRANSCRIPT_ACTIVITY_METADATA_KEY]: { activity, turnKey: "t", revision: 1 } },
      })
    ).toBeNull()
    expect(
      transcriptActivityOf({
        metadata: {
          [TRANSCRIPT_ACTIVITY_METADATA_KEY]: {
            activity: { toolCount: 1 },
            turnKey: "t",
            revision: 1,
            detailRevision: 1,
          },
        },
      })
    ).toBeNull()
  })
})
