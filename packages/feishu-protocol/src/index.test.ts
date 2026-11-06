import * as protocol from "./index"

describe("@cognia/feishu-protocol root export", () => {
  it("exposes each layer-1 concern from one entry", () => {
    for (const name of [
      "larkDeployment",
      "readLarkEnvelope",
      "LarkApiError",
      "requestTenantAccessToken",
      "readAllLarkPages",
      "computeCodeChallenge",
      "mergeLarkScopes",
      "FEISHU_JSON_HEADERS",
      "parseLarkResourceUrl",
      "LARK_HOST_SUFFIXES",
    ])
      expect(protocol).toHaveProperty(name)
  })
})
