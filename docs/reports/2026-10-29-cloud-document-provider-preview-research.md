# Provider options for cloud-document previews

Date: 2026-10-29, Asia/Shanghai. Scope: first-party provider documentation, not Cognia runtime acceptance. No documents were published, permissions changed, credentials inspected, or authenticated provider flows exercised.

## What the providers establish

| Provider / route                             | Verified capability                                                                                                                                                                                                                                                                                                                                             | Integration implication                                                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Docs, Sheets, Slides: published embed | Google documents an **Embed** option under **Publish to web**. Publishing visibility depends on account settings and can include the public web, organization, or an organizational group; administrators can disable publishing. Sheets can publish selected tabs. [Google publishing and embedding help](https://support.google.com/docs/answer/183965?hl=en) | Suitable for documents the owner has deliberately published. A preview must not silently publish a private document or change its sharing settings.                                                   |
| Google: authenticated embedded content       | Chrome's official guide explicitly uses embedded Google Docs as an example of content that may need permission to access its cookies and verify the user's identity. [Chrome embedded-content/cookie guide](https://support.google.com/chrome/answer/95647?hl=en)                                                                                               | Private embedding is not categorically impossible. The guide does **not** guarantee that every ordinary Docs URL can be framed in Cognia, or that API OAuth authorizes a browser session.             |
| Feishu: Docs web component                   | Feishu documents external-system embedding through its browser component SDK: load the SDK, authenticate as a user or application, then render. The solution names a broad document-management application permission as a prerequisite. [Official integration solution](https://open.feishu.cn/solutions/detail/docs?lang=zh-CN)                               | Native document collaboration is an integration project with SDK authentication and document permissions; pasting an ordinary URL into an iframe does not establish this capability.                  |
| Feishu: permissions and display              | The official CMS solution describes read/edit permissions and component display configuration. Its demonstration requires authorization to display a supplied document. [CMS solution](https://open.feishu.cn/solutions/detail/cms?lang=zh-CN), [official component demo](https://open.feishu.cn/web-component/docs-component/?source=open_platform)            | Treat display authorization and underlying document ACLs as explicit dependencies. This research does not establish an exact SDK configuration or support matrix for docx, Sheets, Wiki, and Bitable. |

The Feishu **Docs web component** above embeds documents into another system. It should not be confused with a **Docs add-on**, whose blocks extend Feishu's own document surface. [Add-on terminology](https://open.feishu.cn/document/client-docs/docs-add-on/02-cloud-doc-block-noun-explanation) No ordinary-link iframe guarantee was found in the primary material inspected.

## Authenticated content snapshots

Google offers an alternative to provider-page embedding: authenticated Drive export. `files.export` returns document bytes in a requested supported MIME type and limits exported content to 10 MB. Its accepted scopes include `drive.readonly` and `drive.file`; actual file access still applies. [Drive export endpoint](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)

Supported export formats include Docs Markdown, plain text, HTML and PDF; Sheets PDF/XLSX and CSV/TSV, with CSV/TSV restricted to the first sheet; Slides PDF/PPTX/plain text. This proves export availability, not that Cognia currently requests or renders all those formats. [Export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats)

For future richer readers, the Docs API requires `includeTabsContent=true` to return all document tabs; its default legacy fields contain only the first tab. Slides can return page-thumbnail URLs, but these are short-lived and grant anyone holding the URL the requester's image access. They must not become public permanent artifact URLs. [Docs tabs](https://developers.google.com/workspace/docs/api/how-tos/tabs), [Slides thumbnails](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations.pages/getThumbnail)

## Implications for the right-side artifact area

These are implementation recommendations inferred from the documented provider contracts, not verified Cognia behavior:

1. Distinguish **open original page**, **read-only fetched snapshot**, and **provider-native embedded document**. Each has different authentication, fidelity, and interaction guarantees.
2. A fetched snapshot can use the app's document/table renderer without publishing the source. Show the original link, refresh state, truncation or omitted-content warnings, and read/permission failures.
3. Keep provider-page opening as an explicit option. A connected API account should not be presented as proof that the page's browser session is signed in.
4. Offer published Google embeds only for already-published sources. Evaluate Feishu's authenticated web component separately when native layout, comments, or live collaboration are required.

## Evidence limits

- This research does not inspect Cognia source; the parent investigation owns current runtime wiring and platform reach.
- No authenticated document was opened, and no iframe header, cookie, CSP, login, Tauri WebView, Capacitor, or browser acceptance test ran. Do not infer blanket iframe support or rejection from these documents.
- Feishu's detailed quick-start page returned no readable body through the browsing reader. SDK prerequisites above are supported by indexed first-party solution text; SDK version, signing endpoint, allowed origins, token handoff, and resource-type coverage need a dedicated spike against the detailed contract and an authorized test document before implementation.
- Context7 library resolution was attempted for Feishu and Google Drive, but both returned `Monthly quota exceeded`. Research therefore used official provider pages directly.

## Sources

All links above were retrieved on 2026-10-29. Google help establishes published embedding and cookie considerations; Google API references establish export/read contracts; Feishu's first-party solution pages and component demo establish the external Docs component and its authentication boundary. No secondary write-up is used as implementation evidence.
