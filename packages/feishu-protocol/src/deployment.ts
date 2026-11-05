/**
 * Feishu and Lark are one OpenAPI on two deployments: `feishu.cn` (mainland
 * China) and `larksuite.com` (international). One definition gives the
 * authorization issuer and the API base together, so a caller cannot pair one
 * deployment's issuer with the other's endpoints.
 */

export type FeishuBrand = "feishu" | "lark"

export interface FeishuDeployment {
  /** Authorization server, e.g. `https://accounts.feishu.cn`. */
  issuer: string
  /** OpenAPI base without `/open-apis`, e.g. `https://open.feishu.cn`. */
  apiBase: string
}

/** One deployment definition for authorization identity and every API endpoint. */
export function larkDeployment(brand: FeishuBrand = "feishu"): FeishuDeployment {
  const domain = brand === "lark" ? "larksuite.com" : "feishu.cn"
  return { issuer: `https://accounts.${domain}`, apiBase: `https://open.${domain}` }
}
