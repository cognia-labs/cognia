import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StorageBreakdown } from "./storage-breakdown"
import { getCleanupCategoryAvailability, type StorageCategoryInfo } from "@/lib/storage"
jest.mock("@/lib/storage", () => {
  const actual = jest.requireActual("@/lib/storage")
  return {
    ...actual,
    getCleanupCategoryAvailability: jest.fn(actual.getCleanupCategoryAvailability),
  }
})
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
jest.mock("@/lib/tauri/transport-companion", () => ({
  ...jest.requireActual("@/lib/tauri/transport-companion"),
  loadCompanionConfig: jest.fn(() => null),
}))

const messages = {
  settings: {
    data: {
      breakdown: {
        viewDetails: "View details",
        clearCategory: "Clear category",
        other: "Other",
        noData: "No storage data",
      },
    },
  },
}

function renderBreakdown(props: React.ComponentProps<typeof StorageBreakdown>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <StorageBreakdown {...props} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

const fmt = (n: number) => `${n} B`

it("labels a Host-only category as managed and exposes no clear action", () => {
  Object.assign(
    jest.requireActual("@/i18n/messages/en.json").settings.data,
    jest.requireActual("@/i18n/messages/en/settings/data.json")
  )
  jest
    .mocked(loadCompanionConfig)
    .mockReturnValue({ deviceId: "paired", targetId: "host" } as never)
  try {
    renderBreakdown({
      categories: [
        {
          category: "session",
          displayName: "Sessions",
          itemCount: 1,
          totalSize: 10,
          sources: ["sessions"],
        },
      ],
      totalSize: 10,
      formatBytes: fmt,
      onClearCategory: jest.fn(),
    })
    fireEvent.click(screen.getByRole("button", { name: /view details/i }))
    expect(screen.getByText("Managed by the Host")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /clear this category/i })).toBeNull()
  } finally {
    jest.mocked(loadCompanionConfig).mockReturnValue(null)
  }
})

it("labels mixed categories and keeps cleanup of local-only data available", () => {
  Object.assign(
    jest.requireActual("@/i18n/messages/en.json").settings.data,
    jest.requireActual("@/i18n/messages/en/settings/data.json")
  )
  jest
    .mocked(loadCompanionConfig)
    .mockReturnValue({ deviceId: "paired", targetId: "host" } as never)
  try {
    renderBreakdown({
      categories: [
        {
          category: "session",
          displayName: "Sessions",
          itemCount: 2,
          totalSize: 20,
          sources: ["sessions", "sessionPeerMessages"],
        },
      ],
      totalSize: 20,
      formatBytes: fmt,
      onClearCategory: jest.fn(),
    })
    fireEvent.click(screen.getByRole("button", { name: /view details/i }))
    expect(
      screen.getByText("Host data is managed by the Host. Cleanup affects local-only data.")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /clear this category/i })).toBeEnabled()
  } finally {
    jest.mocked(loadCompanionConfig).mockReturnValue(null)
  }
})

const sample: StorageCategoryInfo[] = [
  {
    category: "session",
    displayName: "Sessions",
    itemCount: 10,
    totalSize: 200,
    sources: ["sessions"],
  },
  {
    category: "chat",
    displayName: "Messages",
    itemCount: 100,
    totalSize: 600,
    sources: ["messages"],
  },
  { category: "skill", displayName: "Skills", itemCount: 5, totalSize: 0, sources: ["skills"] },
]

describe("StorageBreakdown", () => {
  it("renders the no-data placeholder when all sizes are zero", () => {
    renderBreakdown({
      categories: [{ ...sample[0], totalSize: 0 }],
      totalSize: 0,
      formatBytes: fmt,
    })
    // Global jest mock pulls translations from `i18n/messages/en.json`.
    expect(screen.getByText("No storage data yet.")).toBeInTheDocument()
  })

  it("renders one bar segment per non-empty category", () => {
    renderBreakdown({
      categories: sample,
      totalSize: 800,
      formatBytes: fmt,
    })
    expect(screen.getByTestId("breakdown-bar-chat")).toBeInTheDocument()
    expect(screen.getByTestId("breakdown-bar-session")).toBeInTheDocument()
    expect(screen.queryByTestId("breakdown-bar-skill")).not.toBeInTheDocument()
  })

  it("invokes onClearCategory with the bucket key", () => {
    const onClear = jest.fn()
    jest.mocked(getCleanupCategoryAvailability).mockReturnValue("cleanable")
    try {
      renderBreakdown({
        categories: sample,
        totalSize: 800,
        formatBytes: fmt,
        onClearCategory: onClear,
      })
      fireEvent.click(screen.getByText("View details"))
      const clears = screen.getAllByRole("button", { name: /clear this category/i })
      fireEvent.click(clears[0])
      expect(onClear).toHaveBeenCalledTimes(1)
      expect(onClear).toHaveBeenCalledWith("chat")
    } finally {
      jest
        .mocked(getCleanupCategoryAvailability)
        .mockImplementation(jest.requireActual("@/lib/storage").getCleanupCategoryAvailability)
    }
  })
})

it("offers no destructive actions for protected or native-only categories", () => {
  Object.assign(
    jest.requireActual("@/i18n/messages/en.json").settings.data,
    jest.requireActual("@/i18n/messages/en/settings/data.json")
  )
  renderBreakdown({
    categories: [
      {
        category: "pet",
        displayName: "Desktop pet",
        itemCount: 1,
        totalSize: 50,
        sources: ["petProfile"],
      },
      {
        category: "settings",
        displayName: "Settings",
        itemCount: 1,
        totalSize: 50,
        sources: ["settings"],
      },
      {
        category: "vector",
        displayName: "Vector store",
        itemCount: 1,
        totalSize: 1000000,
        sources: ["vectors.sqlite"],
      },
    ],
    totalSize: 100,
    formatBytes: fmt,
    onClearCategory: jest.fn(),
  })
  fireEvent.click(screen.getByRole("button", { name: /view details/i }))
  expect(screen.queryByRole("button", { name: /clear this category/i })).toBeNull()
  const native = screen
    .getByText("Separately measured native store")
    .closest(".border") as HTMLElement
  expect(within(native).queryByRole("progressbar")).toBeNull()
  expect(screen.queryByTestId("breakdown-bar-vector")).toBeNull()
})

it("bounds percentages even when supplied a smaller IndexedDB denominator", () => {
  renderBreakdown({ categories: sample, totalSize: 1, formatBytes: fmt })
  expect(screen.getByTestId("breakdown-bar-chat")).toHaveStyle({ width: "75%" })
})
