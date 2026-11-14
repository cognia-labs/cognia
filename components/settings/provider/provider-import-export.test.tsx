/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProviderImportExport } from "./provider-import-export"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock stores
const mockSetProviderSettings = jest.fn()
const mockAddCustomProvider = jest.fn()
const mockUpdateCustomProvider = jest.fn()
const mockFileReaderReadAsText = jest.fn()
let mockFileReaderContent = ""

const OriginalFileReader = global.FileReader

class MockFileReader {
  onload: ((event: { target: { result: string } }) => void) | null = null

  readAsText() {
    mockFileReaderReadAsText()
    this.onload?.({ target: { result: mockFileReaderContent } })
  }
}

const mockStoreData: { providerSettings: Record<string, unknown>; customProviders: unknown[] } = {
  providerSettings: { openai: { apiKey: "test-key", enabled: true } },
  customProviders: [],
}

jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      providerSettings: mockStoreData.providerSettings,
      customProviders: mockStoreData.customProviders,
      setProviderSettings: mockSetProviderSettings,
      addCustomProvider: mockAddCustomProvider,
      updateCustomProvider: mockUpdateCustomProvider,
    }
    return selector(state)
  },
}))

// Mock UI components. `@/components/ui/button` is deliberately NOT mocked:
// the shared manual mock strips `size`, and the compact-vs-default tests
// assert the rendered `data-size` the rail toolbar's geometry depends on.
jest.mock("@/components/ui/dialog")

jest.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}))

jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
    id?: string
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      id={id}
      data-testid="checkbox"
    />
  ),
}))

jest.mock("@/components/ui/label")

jest.mock("@/components/ui/scroll-area")

jest.mock("@/components/ui/badge")

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div data-testid="tabs">{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tabs-list">{children}</div>
  ),
  TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button data-testid={`tab-${value}`}>{children}</button>
  ),
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select">{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select-trigger">{children}</div>
  ),
  SelectValue: () => <span data-testid="select-value" />,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-testid={`select-item-${value}`}>{children}</div>
  ),
}))

describe("ProviderImportExport", () => {
  beforeAll(() => {
    // jsdom FileReader is replaced so import tests can control payload content deterministically.
    global.FileReader = MockFileReader as unknown as typeof FileReader
  })

  afterAll(() => {
    global.FileReader = OriginalFileReader
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockSetProviderSettings.mockResolvedValue(undefined)
    mockAddCustomProvider.mockResolvedValue("custom-provider")
    mockUpdateCustomProvider.mockResolvedValue(undefined)
    mockFileReaderContent = ""
  })

  it("renders without crashing", () => {
    render(<ProviderImportExport />)
    expect(screen.getByText("export")).toBeInTheDocument()
  })

  it("displays export button", () => {
    render(<ProviderImportExport />)
    expect(screen.getByText("export")).toBeInTheDocument()
  })

  it("displays import button", () => {
    render(<ProviderImportExport />)
    expect(screen.getByText("import")).toBeInTheDocument()
  })

  it("keeps compact sidebar controls accessible without consuming label width", () => {
    render(<ProviderImportExport compact />)
    expect(screen.getByRole("button", { name: "export" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "import" })).toBeInTheDocument()
    expect(screen.getByText("export")).toHaveClass("sr-only")
    expect(screen.getByText("import")).toHaveClass("sr-only")
  })

  // The rail toolbar mixes this pair with `size="icon"` neighbours; compact
  // must render the same 36px square or the row visibly mismatches.
  it("renders compact triggers at icon size to match the rail toolbar", () => {
    render(<ProviderImportExport compact />)
    expect(screen.getByRole("button", { name: "export" })).toHaveAttribute("data-size", "icon")
    expect(screen.getByRole("button", { name: "import" })).toHaveAttribute("data-size", "icon")
  })

  it("keeps labelled sm triggers outside compact mode", () => {
    render(<ProviderImportExport />)
    expect(screen.getByRole("button", { name: "export" })).toHaveAttribute("data-size", "sm")
    expect(screen.getByRole("button", { name: "import" })).toHaveAttribute("data-size", "sm")
  })

  it("opens export dialog on click", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
  })

  it("displays export dialog title", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    expect(screen.getByText("exportTitle")).toBeInTheDocument()
  })

  it("displays include API keys checkbox", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    expect(screen.getByText("includeApiKeys")).toBeInTheDocument()
  })

  it("displays api key warning text", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    expect(screen.getByText("apiKeyWarning")).toBeInTheDocument()
  })

  it("displays export description", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    expect(screen.getByText("exportDescription")).toBeInTheDocument()
  })

  it("displays cancel button in export dialog", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    expect(screen.getByText("cancel")).toBeInTheDocument()
  })

  it("displays exportNow button", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    expect(screen.getByText("exportNow")).toBeInTheDocument()
  })

  it("toggles includeApiKeys checkbox", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    // Multiple checkboxes exist (provider list + include API keys)
    const checkboxes = screen.getAllByTestId("checkbox")
    expect(checkboxes.length).toBeGreaterThan(0)
    fireEvent.click(checkboxes[0])
    expect(checkboxes[0]).toBeInTheDocument()
  })

  it("displays JSON format button in export dialog", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    expect(screen.getByText("JSON")).toBeInTheDocument()
  })

  it("displays .env format button in export dialog", () => {
    render(<ProviderImportExport />)
    fireEvent.click(screen.getByText("export"))
    expect(screen.getByText(".env")).toBeInTheDocument()
  })

  it("renders with onClose callback", () => {
    const mockOnClose = jest.fn()
    render(<ProviderImportExport onClose={mockOnClose} />)
    expect(screen.getByText("export")).toBeInTheDocument()
  })

  it("rejects malformed JSON imports without mutating provider settings", async () => {
    mockFileReaderContent = "{ invalid json }"
    const { container } = render(<ProviderImportExport />)
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["ignored"], "providers.json", { type: "application/json" })],
      },
    })

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument()
    })
    expect(screen.getByRole("alert")).toHaveTextContent(
      /invalid export file format|json|expected property name/i
    )
    expect(mockSetProviderSettings).not.toHaveBeenCalled()
    expect(mockAddCustomProvider).not.toHaveBeenCalled()
    expect(mockUpdateCustomProvider).not.toHaveBeenCalled()
  })

  it("rejects schema-incomplete payloads without mutating provider settings", async () => {
    mockFileReaderContent = JSON.stringify({
      version: 1,
      exportedAt: "2026-03-08T00:00:00.000Z",
    })
    const { container } = render(<ProviderImportExport />)
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["ignored"], "providers.json", { type: "application/json" })],
      },
    })

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument()
    })
    expect(screen.getByText("importErrors.missingProviders")).toBeInTheDocument()
    expect(mockSetProviderSettings).not.toHaveBeenCalled()
    expect(mockAddCustomProvider).not.toHaveBeenCalled()
    expect(mockUpdateCustomProvider).not.toHaveBeenCalled()
  })

  it("maps custom provider validation failures to provider i18n keys", async () => {
    mockFileReaderContent = JSON.stringify({
      version: 1,
      exportedAt: "2026-03-08T00:00:00.000Z",
      customProviders: {
        local_proxy: {
          baseURL: "https://example.com/v1",
        },
      },
    })
    const { container } = render(<ProviderImportExport />)
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["ignored"], "providers.json", { type: "application/json" })],
      },
    })

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument()
    })

    expect(screen.getByText("importErrors.customProviderMissingName")).toBeInTheDocument()
    expect(mockSetProviderSettings).not.toHaveBeenCalled()
    expect(mockAddCustomProvider).not.toHaveBeenCalled()
    expect(mockUpdateCustomProvider).not.toHaveBeenCalled()
  })

  it("imports valid payloads and applies provider settings", async () => {
    mockFileReaderContent = JSON.stringify({
      version: 1,
      exportedAt: "2026-03-08T00:00:00.000Z",
      providerSettings: {
        openai: {
          apiKey: "sk-imported",
          enabled: true,
        },
      },
      customProviders: {},
    })
    const { container } = render(<ProviderImportExport />)
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["ignored"], "providers.json", { type: "application/json" })],
      },
    })

    await waitFor(() => {
      expect(screen.getByText("importNow")).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText("importNow"))

    await waitFor(() => {
      expect(mockSetProviderSettings).toHaveBeenCalledWith(
        "openai",
        expect.objectContaining({
          apiKey: "sk-imported",
          enabled: true,
        })
      )
    })
  })

  it("does not report import success before every settings write is persisted", async () => {
    let resolveWrite: (() => void) | undefined
    mockSetProviderSettings.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveWrite = resolve))
    )
    mockFileReaderContent = JSON.stringify({
      version: 1,
      exportedAt: "2026-03-08T00:00:00.000Z",
      providerSettings: {
        openai: {
          apiKey: "sk-imported",
          enabled: true,
        },
      },
      customProviders: {},
    })
    const { container } = render(<ProviderImportExport />)
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: {
        files: [new File(["ignored"], "providers.json", { type: "application/json" })],
      },
    })
    await waitFor(() => expect(screen.getByText("importNow")).toBeInTheDocument())

    fireEvent.click(screen.getByText("importNow"))

    expect(screen.getByText("importing")).toBeDisabled()
    expect(screen.queryByText("importSuccess")).not.toBeInTheDocument()
    resolveWrite?.()
    await waitFor(() => expect(screen.getByText("importSuccess")).toBeInTheDocument())
  })

  it("reports a persistence failure instead of claiming the import succeeded", async () => {
    mockSetProviderSettings.mockRejectedValueOnce(new Error("database unavailable"))
    mockFileReaderContent = JSON.stringify({
      version: 1,
      exportedAt: "2026-03-08T00:00:00.000Z",
      providerSettings: {
        openai: {
          apiKey: "sk-imported",
          enabled: true,
        },
      },
      customProviders: {},
    })
    const { container } = render(<ProviderImportExport />)
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, {
      target: {
        files: [new File(["ignored"], "providers.json", { type: "application/json" })],
      },
    })
    await waitFor(() => expect(screen.getByText("importNow")).toBeInTheDocument())

    fireEvent.click(screen.getByText("importNow"))

    await waitFor(() =>
      expect(screen.getByText("importErrors.importFailedRetry")).toBeInTheDocument()
    )
    expect(screen.queryByText("importSuccess")).not.toBeInTheDocument()
  })

  describe("credential boundary and round-trip fidelity", () => {
    const SECRET = "sk-synthetic-export"
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    let exported: Blob | undefined

    beforeEach(() => {
      exported = undefined
      URL.createObjectURL = jest.fn((blob: Blob) => {
        exported = blob
        return "blob:test"
      }) as typeof URL.createObjectURL
      URL.revokeObjectURL = jest.fn()
      mockStoreData.providerSettings = {
        openrouter: {
          providerId: "openrouter",
          apiKey: SECRET,
          apiKeys: [SECRET],
          apiKeyUsageStats: { [SECRET]: { usageCount: 1, lastUsed: 1, errorCount: 0 } },
          oauthRefreshToken: SECRET,
          verificationFingerprint: JSON.stringify({ apiKey: SECRET }),
          customHeaders: { Authorization: `Bearer ${SECRET}`, "x-tenant-id": "acme" },
          openRouterSettings: {
            provisioningApiKey: SECRET,
            byokKeys: [
              { id: "b", provider: "openai", config: SECRET, alwaysUse: false, enabled: true },
            ],
          },
          enabled: true,
          defaultModel: "m",
        },
      }
    })

    afterEach(() => {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      mockStoreData.providerSettings = { openai: { apiKey: "test-key", enabled: true } }
      mockStoreData.customProviders = []
    })

    it("exports no credential of any kind when API keys are excluded", async () => {
      render(<ProviderImportExport />)
      fireEvent.click(screen.getByText("export"))
      fireEvent.click(screen.getByText("exportNow"))
      expect(exported).toBeDefined()
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new OriginalFileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(exported!)
      })
      expect(text).not.toContain(SECRET)
      expect(JSON.parse(text).providerSettings.openrouter).toMatchObject({
        customHeaders: { "x-tenant-id": "acme" },
        defaultModel: "m",
      })
    })

    it("imports a custom provider's headers, flavor and inference defaults", async () => {
      mockFileReaderContent = JSON.stringify({
        version: 1,
        exportedAt: "2026-11-14T00:00:00.000Z",
        customProviders: {
          "custom-gw": {
            customName: "Gateway",
            baseURL: "https://gw.example/v1",
            customModels: ["m"],
            defaultModel: "m",
            apiProtocol: "openai",
            apiFlavor: "responses",
            customHeaders: { "x-tenant-id": "acme" },
            inferenceDefaults: { temperature: 0.2 },
            enabled: true,
          },
        },
      })
      const { container } = render(<ProviderImportExport />)
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(fileInput, {
        target: { files: [new File(["ignored"], "providers.json", { type: "application/json" })] },
      })
      await waitFor(() => expect(screen.getByText("importNow")).toBeInTheDocument())
      fireEvent.click(screen.getByText("importNow"))
      await waitFor(() =>
        expect(mockAddCustomProvider).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "custom-gw",
            apiFlavor: "responses",
            customHeaders: { "x-tenant-id": "acme" },
            inferenceDefaults: { temperature: 0.2 },
          })
        )
      )
    })
  })
})
