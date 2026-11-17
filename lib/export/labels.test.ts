const getRuntimeTranslator = jest.fn(
  async (namespace?: string) => (key: string) => `${namespace}|${key}`
)
jest.mock("@/lib/i18n/runtime-translator", () => ({
  currentLocale: async () => "zh-CN",
  getRuntimeTranslator: (namespace?: string) => getRuntimeTranslator(namespace),
}))

import { exportLabelsFrom, loadExportLabels } from "./labels"

const t = (key: string, values?: Record<string, string | number | Date>) =>
  values ? `${key}:${JSON.stringify(values)}` : key

describe("exportLabelsFrom", () => {
  it("names a known speaker and shows any other role as stored", () => {
    const labels = exportLabelsFrom(t, "en")
    expect(labels.role("user")).toBe("roles.user")
    expect(labels.role("assistant")).toBe("roles.assistant")
    expect(labels.role("tool")).toBe("tool")
  })

  it("reads the document chrome and the part labels from one namespace", () => {
    const labels = exportLabelsFrom(t, "en")
    expect(labels.locale).toBe("en")
    expect(labels.conversationInfo).toBe("meta.conversationInfo")
    expect(labels.footer("today")).toBe('footer:{"date":"today"}')
    expect(labels.parts.thinking).toBe("parts.thinking")
  })
})

it("loads the labels in the locale the UI is showing", async () => {
  const labels = await loadExportLabels()
  expect(getRuntimeTranslator).toHaveBeenCalledWith("export.document")
  expect(labels.locale).toBe("zh-CN")
  expect(labels.date).toBe("export.document|meta.date")
})
