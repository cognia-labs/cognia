import {
  fitsTier,
  menubarFolds,
  navigationFolds,
  tierForWidth,
  TITLE_BAR_TIER_MAX_PX,
  TITLE_BAR_TIER_QUERIES,
} from "./title-bar-density"

test("maps a width to its tier at the shared breakpoints", () => {
  expect(tierForWidth(640)).toBe("compact")
  expect(tierForWidth(760)).toBe("compact")
  expect(tierForWidth(761)).toBe("medium")
  expect(tierForWidth(1023)).toBe("medium")
  expect(tierForWidth(1024)).toBe("regular")
  expect(tierForWidth(1279)).toBe("regular")
  expect(tierForWidth(1280)).toBe("wide")
})

test("builds one max-width query per tier below wide, narrowest first", () => {
  expect(TITLE_BAR_TIER_QUERIES).toEqual([
    ["compact", `(max-width: ${TITLE_BAR_TIER_MAX_PX.compact}px)`],
    ["medium", `(max-width: ${TITLE_BAR_TIER_MAX_PX.medium}px)`],
    ["regular", `(max-width: ${TITLE_BAR_TIER_MAX_PX.regular}px)`],
  ])
})

test("a segment's floor names the tier it needs", () => {
  expect(fitsTier(undefined, "compact")).toBe(true)
  expect(fitsTier("lg", "medium")).toBe(false)
  expect(fitsTier("lg", "regular")).toBe(true)
  expect(fitsTier("xl", "regular")).toBe(false)
  expect(fitsTier("xl", "wide")).toBe(true)
})

test("the menubar folds when compact or when the rail header takes its stretch", () => {
  expect(menubarFolds("compact", false)).toBe(true)
  expect(menubarFolds("medium", false)).toBe(false)
  expect(menubarFolds("wide", true)).toBe(true)
})

test("navigation beside a projected chat header folds below the lg floor", () => {
  expect(navigationFolds("compact")).toBe(true)
  expect(navigationFolds("medium")).toBe(true)
  expect(navigationFolds("regular")).toBe(false)
  expect(navigationFolds("wide")).toBe(false)
})
