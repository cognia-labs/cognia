"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { parseCSV } from "@cognia/document/parsers/csv-parser"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { Button } from "@/components/ui/button"

/** Split only outside quoted fields: a multiline cell may itself contain `## `. */
export function parseDocumentGrid(text: string) {
  const sections: Array<{ title: string; lines: string[]; note: string[] }> = []
  let section = { title: "", lines: [] as string[], note: [] as string[] }
  let quoted = false
  for (const line of text.split(/\r?\n/)) {
    if (!quoted && line.startsWith("## ")) {
      if (section.lines.length || section.title) sections.push(section)
      section = { title: line.slice(3), lines: [], note: [] }
      continue
    }
    if (!quoted && /^\[(Truncated|Incomplete) by Cognia:/.test(line)) {
      section.note.push(line)
      continue
    }
    if (line || quoted) section.lines.push(line)
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '"') continue
      if (quoted && line[i + 1] === '"') i++
      else quoted = !quoted
    }
  }
  if (section.lines.length || section.title) sections.push(section)
  return sections.map(({ title, lines, note }) => ({
    title,
    note: note.join("\n"),
    ...parseCSV(lines.join("\n"), { delimiter: ",", trimValues: false }),
  }))
}

export function DocumentGridView({ text }: { text: string }) {
  const t = useTranslations("cloudDocPreview")
  const [source, setSource] = useState(false)
  const sections = useMemo(() => parseDocumentGrid(text), [text])
  return (
    <div className="min-w-0 space-y-4 p-4">
      <Button
        size="sm"
        variant="outline"
        aria-pressed={source}
        onClick={() => setSource((value) => !value)}
      >
        {t("grid.source")}
      </Button>
      {source ? (
        <CodeBlock code={text} language="csv" />
      ) : (
        sections.map((section, index) => (
          <section key={index} className="space-y-2">
            <h3 className="text-sm font-medium">
              {section.title || t("grid.section", { number: index + 1 })}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("grid.dimensions", { rows: section.rowCount, columns: section.columnCount })}
            </p>
            <div className="max-h-96 overflow-auto rounded-md border">
              <table
                className="w-full border-collapse text-left text-xs"
                aria-label={section.title || t("grid.section", { number: index + 1 })}
              >
                <thead className="sticky top-0 bg-background">
                  <tr>
                    {Array.from({ length: section.columnCount }, (_, col) => (
                      <th key={col} scope="col" className="whitespace-pre border-b px-3 py-2">
                        {section.headers[col] ?? ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.data.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {Array.from({ length: section.columnCount }, (_, col) => (
                        <td key={col} className="whitespace-pre border-b px-3 py-2 align-top">
                          {row[col] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {section.note ? <p className="text-xs text-muted-foreground">{section.note}</p> : null}
          </section>
        ))
      )}
    </div>
  )
}
