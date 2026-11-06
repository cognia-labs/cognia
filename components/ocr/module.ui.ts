import { defineUiModule } from "@/lib/modules/define"

// The OCR module's UI layer (ADR-0250 §14). Its host layer is
// `lib/ocr/module.ts`.
export default defineUiModule({
  id: "ocr",
  settingsSections: [
    {
      id: "ocr",
      group: "capabilities",
      icon: "ScrollText",
      label: "settings.tabs.ocr",
      description: "settings.descriptions.ocr",
      after: "memory",
      // A provider rail and a detail pane, each scrolling on its own.
      layout: "fill",
      keywords: [
        "ocr",
        "image",
        "pdf",
        "extract text",
        "tesseract",
        "mistral ocr",
        "google vision",
        "aws textract",
        "azure document",
        "mathpix",
        "abbyy",
        "nanonets",
        "windows ocr",
        "apple vision",
        "ml kit",
        "feishu",
        "lark",
        "光学字符识别",
        "图片识别",
        "扫描",
        "PDF 文字",
        "识别图片文字",
      ],
      load: () => import("@/components/settings/ocr/ocr-section-persisted"),
    },
  ],
})
