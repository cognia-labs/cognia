import {
  computeTitleBarGeometry,
  TITLE_BAR_MIN_CENTRE_RATIO,
  type TitleBarGeometryInput,
} from "./title-bar-geometry"

const base: TitleBarGeometryInput = {
  barPx: 1600,
  paddingLeftPx: 8,
  leftChromePx: 32,
  rightChromePx: 200,
  sidebarSide: "left",
  railPx: 56,
  sidebarPx: 280,
  dockPx: 0,
  projectedStart: false,
  projectedEnd: false,
}

test("reserves nothing while no column header projects", () => {
  expect(computeTitleBarGeometry({ ...base, dockPx: 400 })).toEqual({
    startOutletPx: 0,
    endOutletPx: 0,
  })
})

test("sizes the start outlet to rail + sidebar, less the chrome already over them", () => {
  const { startOutletPx } = computeTitleBarGeometry({ ...base, projectedStart: true })
  expect(startOutletPx).toBe(56 + 280 - 8 - 32)
})

test("sizes the end outlet to the dock, less the trailing chrome", () => {
  const { endOutletPx } = computeTitleBarGeometry({ ...base, dockPx: 480, projectedEnd: true })
  expect(endOutletPx).toBe(480 - 200)
})

test("never goes negative when the chrome is wider than the column", () => {
  const { startOutletPx, endOutletPx } = computeTitleBarGeometry({
    ...base,
    railPx: 0,
    sidebarPx: 20,
    dockPx: 50,
    projectedStart: true,
    projectedEnd: true,
  })
  expect(startOutletPx).toBe(0)
  expect(endOutletPx).toBe(0)
})

test("with the sidebar on the right the end outlet spans rail and sidebar", () => {
  const { endOutletPx } = computeTitleBarGeometry({
    ...base,
    sidebarSide: "right",
    dockPx: 300,
    projectedEnd: true,
  })
  expect(endOutletPx).toBe(56 + 280 + 300 - 200)
})

test("a projected start header owns the sidebar, so the end outlet does not span it", () => {
  const { endOutletPx } = computeTitleBarGeometry({
    ...base,
    sidebarSide: "right",
    dockPx: 300,
    projectedStart: true,
    projectedEnd: true,
  })
  expect(endOutletPx).toBe(56 + 300 - 200)
})

test("keeps the centre at its floor, taking the deficit from the end outlet first", () => {
  const input = { ...base, barPx: 1200, dockPx: 900, projectedEnd: true }
  const { endOutletPx } = computeTitleBarGeometry(input)
  const centre = 1200 - 8 - 32 - 200 - endOutletPx
  expect(centre).toBe(Math.round(1200 * TITLE_BAR_MIN_CENTRE_RATIO))
})

test("once the end outlet is spent, the start outlet gives up the rest", () => {
  const { startOutletPx, endOutletPx } = computeTitleBarGeometry({
    ...base,
    barPx: 1000,
    sidebarPx: 600,
    dockPx: 260,
    projectedStart: true,
    projectedEnd: true,
  })
  expect(endOutletPx).toBe(0)
  const centre = 1000 - 8 - 32 - 200 - startOutletPx
  expect(centre).toBe(500)
})

test("an unmeasured bar shaves nothing off the columns", () => {
  expect(
    computeTitleBarGeometry({ ...base, barPx: 0, dockPx: 900, projectedEnd: true }).endOutletPx
  ).toBe(700)
})
