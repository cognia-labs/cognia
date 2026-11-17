import { escapeHtml, markdownToSafeHtml } from "./markdown-html"

describe("markdownToSafeHtml", () => {
  it("renders block Markdown: headings, lists, tables and fenced code", () => {
    const html = markdownToSafeHtml(
      "# Title\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1 < 2\n```"
    )
    expect(html).toContain("<h1>Title</h1>")
    expect(html).toContain("<li>a</li>")
    expect(html).toContain("<table>")
    expect(html).toContain("const a = 1 &lt; 2")
  })

  it("shows raw HTML as text instead of parsing it", () => {
    const html = markdownToSafeHtml('<img src=x onerror="alert(1)">\n\nInline <b>bold</b>')
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<b>")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
  })

  it("keeps a link or image only for a scheme that cannot run script", () => {
    const html = markdownToSafeHtml(
      "[a](javascript:alert(1)) [b](https://x.test) [c](file:///etc/passwd) ![d](javascript:x) ![e](data:image/png;base64,AA)"
    )
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("file:")
    expect(html).toContain('<a href="https://x.test" target="_blank" rel="noreferrer">b</a>')
    expect(html).toContain("</a> c d <img")
    expect(html).toContain('<img src="data:image/png;base64,AA" alt="e" loading="lazy">')
  })
})

it("escapes every character HTML gives meaning to", () => {
  expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
  )
})
