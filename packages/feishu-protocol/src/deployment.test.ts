import { larkDeployment } from "./deployment"
import { buildLarkOAuthUrl } from "./oauth"

it("derives each deployment's issuer and endpoints together", async () => {
  expect(larkDeployment()).toEqual({
    issuer: "https://accounts.feishu.cn",
    apiBase: "https://open.feishu.cn",
  })
  expect(larkDeployment("lark")).toEqual({
    issuer: "https://accounts.larksuite.com",
    apiBase: "https://open.larksuite.com",
  })
  expect(
    new URL(
      buildLarkOAuthUrl({
        appId: "app",
        redirectUri: "https://callback.test",
        state: "state",
        brand: "lark",
      })
    ).origin
  ).toBe("https://accounts.larksuite.com")
})
