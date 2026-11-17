import { resolveChatMarkdownConfig } from "./chat-markdown-config"
import { chatStreamdownMath, resolveChatStreamdownConfig } from "./chat-streamdown-config"
import { chatMarkdownUrlTransform, chatStreamdownRehypePlugins } from "./rendering-policy"

jest.mock("./streaming-fence-renderers", () => ({
  withStreamingFenceRenderers: (plugins: object, options: object) => ({ ...plugins, options }),
}))
jest.mock("@/components/ai-elements/streamdown-plugins", () => ({
  selectStreamdownPlugins: (options: { math?: boolean }) => ({
    selected: options,
    ...(options.math ? { math: { name: "stock-math" } } : {}),
  }),
}))

describe("resolveChatStreamdownConfig", () => {
  it("derives Streamdown's plugin set from the same knobs, fence renderers included", () => {
    const streamdown = resolveChatStreamdownConfig({ diff: true, charts: false, mermaid: true })
    expect(streamdown.config).toBe(
      resolveChatMarkdownConfig({ diff: true, charts: false, mermaid: true })
    )
    expect(streamdown.plugins).toMatchObject({
      selected: { math: true, mermaid: true },
      options: { mermaid: true, charts: false, diff: true },
    })
    expect(streamdown.rehypePlugins).toBe(chatStreamdownRehypePlugins)
    expect(streamdown.urlTransform).toBe(chatMarkdownUrlTransform)
    expect(streamdown.lineNumbers).toBe(true)
  })

  it("is stable for the same knobs and follows them when they change", () => {
    const first = resolveChatStreamdownConfig({ codeLineNumbers: false })
    expect(resolveChatStreamdownConfig({ codeLineNumbers: false })).toBe(first)
    expect(first.lineNumbers).toBe(false)
    expect(resolveChatStreamdownConfig({ math: false }).plugins).toMatchObject({
      selected: { math: false },
    })
  })

  it("reads single-dollar inline math while streaming, as the finished branch does", () => {
    expect(chatStreamdownMath).toMatchObject({ options: { singleDollarTextMath: true } })
    expect(resolveChatStreamdownConfig({ mathCopy: false }).plugins.math).toBe(chatStreamdownMath)
    expect(
      resolveChatStreamdownConfig({ math: false, mathCopy: false }).plugins
    ).not.toHaveProperty("math")
  })
})
