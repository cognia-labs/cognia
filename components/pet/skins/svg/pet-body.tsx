// The parametric body for the SVG skin. One component renders every species
// by reading its traits (silhouette, ears, tail, face, feet, arms, signature
// feature) and the bones palette + body type. All drawing happens in the
// 100×100 pet viewBox.
//
// Depth comes from two gradient overlays (a top-left shine and a bottom
// shade) drawn over the flat palette fill, plus a faint ink outline, so the
// pet reads on light and dark backgrounds alike and any palette format works
// (the rolled palettes are `oklch()` strings, which this file never parses).
// No filters: everything stays cheap enough for low-power mode.

import { useId, type ReactNode, type SVGProps } from "react"
import type { PetBones, PetHat } from "@/types/pet"
import {
  getSpeciesTraits,
  type PetSilhouette,
  type PetSpeciesTraits,
} from "@/lib/pet/skins/species-traits"

const CX = 50
const BODY_CY = 58
const INK = "var(--pet-ink, #2a2a33)"
/** The outline every part shares: present, never heavy. */
export const PET_OUTLINE = { stroke: INK, strokeOpacity: 0.22, strokeWidth: 1.4 } as const
const BEAK = "#ff9f1c"

export interface BodyDims {
  rx: number
  ry: number
}

export function bodyDims(bones: PetBones, traits: PetSpeciesTraits): BodyDims {
  const base =
    bones.bodyType === "tall"
      ? { rx: 26, ry: 34 }
      : bones.bodyType === "wide"
        ? { rx: 34, ry: 26 }
        : { rx: 30, ry: 30 }
  // Pull toward a circle by the species roundness floor.
  const target = 30
  return {
    rx: base.rx + (target - base.rx) * traits.roundness,
    ry: base.ry + (target - base.ry) * traits.roundness,
  }
}

/** Where the head's outline sits at `deg` degrees from straight up. */
function headPoint(
  { rx, ry }: BodyDims,
  silhouette: PetSilhouette,
  deg: number,
  side: -1 | 1
): [number, number] {
  const rad = (deg * Math.PI) / 180
  const x = CX + side * rx * Math.sin(rad)
  // A box's top is flat until its rounded corner.
  const y = silhouette === "box" ? BODY_CY - ry + 1 : BODY_CY - ry * Math.cos(rad)
  return [x, y]
}

/** The y of the top of the head, where hats and caps sit. */
export function headTop(dims: BodyDims): number {
  return BODY_CY - dims.ry
}

function silhouettePath(silhouette: PetSilhouette, { rx, ry }: BodyDims): string {
  const top = BODY_CY - ry
  const bottom = BODY_CY + ry
  // Shared upper half: a dome that widens toward the hips.
  const right = `C ${CX + rx * 0.56} ${top} ${CX + rx} ${BODY_CY - ry * 0.45} ${CX + rx} ${BODY_CY + ry * 0.15}`
  const left = `C ${CX - rx} ${BODY_CY - ry * 0.45} ${CX - rx * 0.56} ${top} ${CX} ${top}`
  switch (silhouette) {
    case "mochi":
      // Sits: the lower half is fuller and flatter than the top.
      return [
        `M ${CX} ${top}`,
        right,
        `C ${CX + rx} ${BODY_CY + ry * 0.74} ${CX + rx * 0.72} ${bottom} ${CX} ${bottom}`,
        `C ${CX - rx * 0.72} ${bottom} ${CX - rx} ${BODY_CY + ry * 0.74} ${CX - rx} ${BODY_CY + ry * 0.15}`,
        left,
        "Z",
      ].join(" ")
    case "ghost":
    case "tentacles": {
      // A dome over a hem: a ghost's points down between shallow scallops; an
      // octopus' four lobes curl under.
      const lobes = silhouette === "ghost" ? 3 : 4
      const hemY = silhouette === "ghost" ? bottom : bottom - 3
      const depth = silhouette === "ghost" ? -5 : 6
      const w = (rx * 2) / lobes
      const hem: string[] = []
      for (let i = 0; i < lobes; i++) {
        const x0 = CX + rx - w * i
        hem.push(`Q ${x0 - w / 2} ${hemY + depth} ${x0 - w} ${hemY}`)
      }
      return [
        `M ${CX} ${top}`,
        right,
        `L ${CX + rx} ${hemY}`,
        ...hem,
        `L ${CX - rx} ${BODY_CY + ry * 0.15}`,
        left,
        "Z",
      ].join(" ")
    }
    case "box": {
      const r = Math.min(rx, ry) * 0.5
      return [
        `M ${CX - rx + r} ${top}`,
        `L ${CX + rx - r} ${top}`,
        `Q ${CX + rx} ${top} ${CX + rx} ${top + r}`,
        `L ${CX + rx} ${bottom - r}`,
        `Q ${CX + rx} ${bottom} ${CX + rx - r} ${bottom}`,
        `L ${CX - rx + r} ${bottom}`,
        `Q ${CX - rx} ${bottom} ${CX - rx} ${bottom - r}`,
        `L ${CX - rx} ${top + r}`,
        `Q ${CX - rx} ${top} ${CX - rx + r} ${top}`,
        "Z",
      ].join(" ")
    }
  }
}

/** Gradient ids for one rendered pet; unique per instance (many pets per page). */
export interface ShadeIds {
  shine: string
  shade: string
}

export function usePetShadeIds(): ShadeIds {
  // `useId` output carries characters that are awkward inside `url(#…)`.
  const base = `pet-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  return { shine: `${base}-shine`, shade: `${base}-shade` }
}

/** The gradients every shaded part reuses. */
export function PetShadeDefs({ ids }: { ids: ShadeIds }) {
  return (
    <defs>
      <radialGradient id={ids.shine} cx="0.32" cy="0.22" r="0.62">
        <stop offset="0" stopColor="#ffffff" stopOpacity={0.55} />
        <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
      </radialGradient>
      <linearGradient id={ids.shade} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.45" stopColor="#000000" stopOpacity={0} />
        <stop offset="1" stopColor="#000000" stopOpacity={0.16} />
      </linearGradient>
    </defs>
  )
}

/**
 * One shape drawn as a shaded, outlined solid: the fill, the shade and shine
 * overlays, then the outline on top so the overlays never eat its inner half.
 */
function Solid({
  ids,
  fill,
  shine = true,
  children,
}: {
  ids: ShadeIds
  fill: string
  shine?: boolean
  children: (props: SVGProps<SVGElement>) => ReactNode
}) {
  return (
    <>
      {children({ fill })}
      {children({ fill: `url(#${ids.shade})` })}
      {shine ? children({ fill: `url(#${ids.shine})` }) : null}
      {children({ fill: "none", ...PET_OUTLINE })}
    </>
  )
}

interface PartProps {
  traits: PetSpeciesTraits
  dims: BodyDims
  bones: PetBones
  ids: ShadeIds
}

function Ears({ traits, dims, bones, ids }: PartProps) {
  const { primary, secondary, accent } = bones.palette
  const top = headTop(dims)
  const sides = [-1, 1] as const
  const at = (deg: number, side: -1 | 1) => headPoint(dims, traits.silhouette, deg, side)
  switch (traits.ears) {
    case "none":
      return null
    case "cat":
    case "tuft": {
      // Cat ears stand tall over the brow; an owl's tufts are short and
      // splay outward from the corners of the head.
      const cat = traits.ears === "cat"
      const tall = cat ? 12 : 7
      return (
        <g data-pet-part="ears" data-ears={traits.ears}>
          {sides.map((side) => {
            const [x1, y1] = at(cat ? 18 : 34, side)
            const [x2, y2] = at(cat ? 54 : 60, side)
            const tip: [number, number] = [CX + side * dims.rx * (cat ? 0.68 : 0.9), top - tall]
            const d = `M ${x1} ${y1 + 3} L ${tip[0]} ${tip[1]} L ${x2} ${y2 + 3} Z`
            const inner = `M ${x1 + (tip[0] - x1) * 0.25} ${y1 + 2} L ${tip[0] - side * 1.2} ${tip[1] + 5} L ${x2 + (tip[0] - x2) * 0.25} ${y2 + 2} Z`
            return (
              <g key={side}>
                <Solid ids={ids} fill={primary} shine={false}>
                  {(p) => (
                    <path d={d} strokeLinejoin="round" {...(p as SVGProps<SVGPathElement>)} />
                  )}
                </Solid>
                {traits.ears === "cat" ? <path d={inner} fill="#ff9fb2" opacity={0.75} /> : null}
              </g>
            )
          })}
        </g>
      )
    }
    case "rabbit":
      return (
        <g data-pet-part="ears" data-ears="rabbit">
          {sides.map((side) => {
            const [x, y] = at(16, side)
            const cx = x + side * 3
            const cy = y - 13
            const rotate = `rotate(${side * 10} ${cx} ${cy})`
            return (
              <g key={side} transform={rotate}>
                <Solid ids={ids} fill={primary} shine={false}>
                  {(p) => (
                    <ellipse
                      cx={cx}
                      cy={cy}
                      rx={5.5}
                      ry={15}
                      {...(p as SVGProps<SVGEllipseElement>)}
                    />
                  )}
                </Solid>
                <ellipse cx={cx} cy={cy + 1} rx={2.6} ry={10.5} fill="#ff9fb2" opacity={0.7} />
              </g>
            )
          })}
        </g>
      )
    case "round":
      return (
        <g data-pet-part="ears" data-ears="round">
          {sides.map((side) => {
            const [x, y] = at(46, side)
            return (
              <g key={side}>
                <Solid ids={ids} fill={primary} shine={false}>
                  {(p) => <circle cx={x} cy={y} r={7} {...(p as SVGProps<SVGCircleElement>)} />}
                </Solid>
                <circle cx={x} cy={y} r={3.6} fill={secondary} />
              </g>
            )
          })}
        </g>
      )
    case "horns":
      return (
        <g data-pet-part="ears" data-ears="horns">
          {sides.map((side) => {
            const [x1, y1] = at(20, side)
            const [x2, y2] = at(38, side)
            const tip = [CX + side * dims.rx * 0.62, top - 11]
            const d = `M ${x1} ${y1 + 2} Q ${x1 + side * 1} ${tip[1] + 4} ${tip[0]} ${tip[1]} Q ${x2 - side * 1} ${y2 - 4} ${x2} ${y2 + 2} Z`
            return <path key={side} d={d} fill="#f3e6c4" strokeLinejoin="round" {...PET_OUTLINE} />
          })}
        </g>
      )
    case "fin":
      return (
        <g
          data-pet-part="ears"
          data-ears="fin"
          stroke={accent}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
        >
          <path d={`M ${CX - dims.rx * 0.8} ${BODY_CY - 4} q -8 -4 -10 4`} />
          <path d={`M ${CX + dims.rx * 0.8} ${BODY_CY - 4} q 8 -4 10 4`} />
        </g>
      )
    case "antenna":
      return (
        <g data-pet-part="ears" data-ears="antenna">
          {sides.map((side) => {
            const [x, y] = at(14, side)
            const tip = [CX + side * dims.rx * 0.42, top - 13]
            return (
              <g key={side}>
                <path
                  d={`M ${x} ${y + 2} Q ${x} ${tip[1] + 4} ${tip[0]} ${tip[1]}`}
                  stroke={INK}
                  strokeOpacity={0.7}
                  strokeWidth={1.8}
                  fill="none"
                  strokeLinecap="round"
                />
                <Solid ids={ids} fill={accent}>
                  {(p) => (
                    <circle
                      cx={tip[0]}
                      cy={tip[1]}
                      r={3.3}
                      {...(p as SVGProps<SVGCircleElement>)}
                    />
                  )}
                </Solid>
              </g>
            )
          })}
        </g>
      )
    case "gills":
      // Three frilly stalks a side, the axolotl's whole silhouette.
      return (
        <g data-pet-part="ears" data-ears="gills" strokeLinecap="round" fill="none">
          {sides.map((side) => {
            const bx = CX + side * dims.rx * 0.86
            const by = BODY_CY - dims.ry * 0.38
            return (
              <g key={side}>
                {[
                  [11, -10],
                  [13, -2],
                  [10, 6],
                ].map(([dx, dy], i) => (
                  <g key={i}>
                    <line
                      x1={bx}
                      y1={by + i * 2}
                      x2={bx + side * dx}
                      y2={by + dy}
                      stroke={accent}
                      strokeWidth={3.6}
                    />
                    <circle cx={bx + side * dx} cy={by + dy} r={2.2} fill={accent} />
                  </g>
                ))}
              </g>
            )
          })}
        </g>
      )
  }
}

function Tail({ traits, dims, bones, ids }: PartProps) {
  const { primary, secondary, accent } = bones.palette
  const x = CX + dims.rx * 0.82
  const y = BODY_CY + dims.ry * 0.45
  switch (traits.tail) {
    case "none":
      return null
    case "curl":
      return (
        <g data-pet-part="tail" data-tail="curl">
          <path
            d={`M ${x - 2} ${y} q 14 -1 12 -12 q -2 -7 -9 -4`}
            stroke={INK}
            strokeOpacity={0.22}
            strokeWidth={6.2}
            fill="none"
            strokeLinecap="round"
          />
          <path
            d={`M ${x - 2} ${y} q 14 -1 12 -12 q -2 -7 -9 -4`}
            stroke={primary}
            strokeWidth={4}
            fill="none"
            strokeLinecap="round"
          />
        </g>
      )
    case "puff":
      return (
        <g data-pet-part="tail" data-tail="puff">
          <Solid ids={ids} fill={secondary}>
            {(p) => <circle cx={x + 3} cy={y} r={6.5} {...(p as SVGProps<SVGCircleElement>)} />}
          </Solid>
        </g>
      )
    case "point":
      return (
        <g data-pet-part="tail" data-tail="point">
          <Solid ids={ids} fill={primary} shine={false}>
            {(p) => (
              <path
                d={`M ${x - 4} ${y - 4} Q ${x + 10} ${y - 2} ${x + 14} ${y - 10} L ${x + 12} ${y + 3} Q ${x + 4} ${y + 6} ${x - 4} ${y + 5} Z`}
                strokeLinejoin="round"
                {...(p as SVGProps<SVGPathElement>)}
              />
            )}
          </Solid>
          <path d={`M ${x + 14} ${y - 10} l -4 3 l 3 3 z`} fill={accent} />
        </g>
      )
    case "fan":
      return (
        <g data-pet-part="tail" data-tail="fan">
          <Solid ids={ids} fill={primary} shine={false}>
            {(p) => (
              <path
                d={`M ${x - 4} ${y} q 10 -14 18 -8 q -2 6 -4 8 q 4 2 2 8 q -8 4 -16 -2 z`}
                strokeLinejoin="round"
                {...(p as SVGProps<SVGPathElement>)}
              />
            )}
          </Solid>
        </g>
      )
    case "bushy":
      // A fox's brush: a full teardrop with a pale tip.
      return (
        <g data-pet-part="tail" data-tail="bushy">
          <Solid ids={ids} fill={primary}>
            {(p) => (
              <path
                d={`M ${x - 6} ${y + 5} C ${x + 8} ${y + 8} ${x + 24} ${y - 2} ${x + 21} ${y - 24} C ${x + 10} ${y - 18} ${x - 4} ${y - 10} ${x - 6} ${y + 5} Z`}
                {...(p as SVGProps<SVGPathElement>)}
              />
            )}
          </Solid>
          <path
            d={`M ${x + 21} ${y - 24} C ${x + 16} ${y - 20} ${x + 12} ${y - 18} ${x + 11} ${y - 14} C ${x + 16} ${y - 13} ${x + 21} ${y - 16} ${x + 21} ${y - 24} Z`}
            fill={secondary}
          />
        </g>
      )
  }
}

/** Behind the body: shells. */
function BackFeature({ traits, dims, bones, ids }: PartProps) {
  const { accent } = bones.palette
  switch (traits.feature) {
    case "shell":
      return (
        <g data-pet-part="feature" data-feature="shell">
          <Solid ids={ids} fill={accent}>
            {(p) => (
              <ellipse
                cx={CX}
                cy={BODY_CY + 4}
                rx={dims.rx + 5}
                ry={dims.ry - 3}
                {...(p as SVGProps<SVGEllipseElement>)}
              />
            )}
          </Solid>
          {/* The shell's rim, so the ring around the body reads as a shell. */}
          <ellipse
            cx={CX}
            cy={BODY_CY + 4}
            rx={dims.rx + 2.4}
            ry={dims.ry - 5.4}
            fill="none"
            stroke="#ffffff"
            strokeOpacity={0.4}
            strokeWidth={1.4}
          />
        </g>
      )
    case "puddle":
      // A blob is half melted: it sits in a pool of itself.
      return (
        <g data-pet-part="feature" data-feature="puddle">
          <ellipse
            cx={CX}
            cy={BODY_CY + dims.ry - 1}
            rx={dims.rx * 1.12}
            ry={5.5}
            fill={bones.palette.primary}
            {...PET_OUTLINE}
          />
        </g>
      )
    case "spiral-shell": {
      const r = dims.ry * 0.62
      const cx = CX + dims.rx * 0.62
      const cy = BODY_CY - dims.ry * 0.34
      return (
        <g data-pet-part="feature" data-feature="spiral-shell">
          <Solid ids={ids} fill={accent}>
            {(p) => <circle cx={cx} cy={cy} r={r} {...(p as SVGProps<SVGCircleElement>)} />}
          </Solid>
          <path
            d={`M ${cx} ${cy} m -2 0 a 2 2 0 1 1 4 0 a 5 5 0 1 1 -9 -1 a 9 9 0 1 1 15 6`}
            fill="none"
            stroke={INK}
            strokeOpacity={0.35}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </g>
      )
    }
    default:
      return null
  }
}

/** In front of the body: caps, spines, drips. */
function FrontFeature({ traits, dims, bones, ids }: PartProps) {
  const { accent } = bones.palette
  const top = headTop(dims)
  switch (traits.feature) {
    case "cap": {
      // The cap covers the brow but never the eyes (y≈44 and below).
      const rim = Math.min(top + dims.ry * 0.5, 43)
      const w = dims.rx + 7
      const d = `M ${CX - w} ${rim} C ${CX - w} ${top - 14} ${CX + w} ${top - 14} ${CX + w} ${rim} Q ${CX} ${rim + 5} ${CX - w} ${rim} Z`
      return (
        <g data-pet-part="feature" data-feature="cap">
          <Solid ids={ids} fill={accent}>
            {(p) => <path d={d} {...(p as SVGProps<SVGPathElement>)} />}
          </Solid>
          <g fill="#ffffff" opacity={0.9}>
            <circle cx={CX - w * 0.45} cy={rim - 8} r={3.4} />
            <circle cx={CX + w * 0.15} cy={top - 3} r={4.2} />
            <circle cx={CX + w * 0.62} cy={rim - 6} r={2.6} />
          </g>
        </g>
      )
    }
    case "spines": {
      const ticks: [number, number, number][] = [
        [-0.72, -0.2, -1],
        [-0.8, 0.35, -1],
        [0.72, -0.15, 1],
        [0.8, 0.4, 1],
        [-0.3, 0.75, -1],
        [0.32, 0.72, 1],
      ]
      return (
        <g data-pet-part="feature" data-feature="spines">
          <g stroke={INK} strokeOpacity={0.45} strokeWidth={1.2} strokeLinecap="round">
            {ticks.map(([fx, fy, side], i) => {
              const x = CX + dims.rx * fx
              const y = BODY_CY + dims.ry * fy
              return <line key={i} x1={x} y1={y} x2={x + side * 3} y2={y - 2} />
            })}
          </g>
          {/* The flower that makes a green box a cactus. */}
          <g transform={`translate(${CX + dims.rx * 0.35} ${top + 1})`}>
            {[0, 72, 144, 216, 288].map((deg) => (
              <ellipse
                key={deg}
                cx={0}
                cy={-3.4}
                rx={2.4}
                ry={3.4}
                fill="#ff7aa8"
                transform={`rotate(${deg})`}
              />
            ))}
            <circle r={2} fill="#ffd24a" />
          </g>
        </g>
      )
    }
    case "shell":
      // Front view of a turtle: the plastron's plates across the belly.
      return (
        <g
          data-pet-part="feature"
          data-feature="plastron"
          fill="none"
          stroke={INK}
          strokeOpacity={0.18}
          strokeWidth={1.1}
          strokeLinecap="round"
        >
          <line x1={CX} y1={BODY_CY + dims.ry * 0.02} x2={CX} y2={BODY_CY + dims.ry * 0.78} />
          <line
            x1={CX - dims.rx * 0.5}
            y1={BODY_CY + dims.ry * 0.3}
            x2={CX + dims.rx * 0.5}
            y2={BODY_CY + dims.ry * 0.3}
          />
          <line
            x1={CX - dims.rx * 0.46}
            y1={BODY_CY + dims.ry * 0.56}
            x2={CX + dims.rx * 0.46}
            y2={BODY_CY + dims.ry * 0.56}
          />
        </g>
      )
    default:
      return null
  }
}

function Feet({ traits, dims, ids, bones }: PartProps) {
  const bottom = BODY_CY + dims.ry
  const sides = [-1, 1] as const
  switch (traits.feet) {
    case "none":
      return null
    case "paws":
      return (
        <g data-pet-part="feet" data-feet="paws">
          {sides.map((side) => (
            <Solid key={side} ids={ids} fill={bones.palette.primary} shine={false}>
              {(p) => (
                <ellipse
                  cx={CX + side * dims.rx * 0.42}
                  cy={bottom - 1}
                  rx={6.5}
                  ry={4}
                  {...(p as SVGProps<SVGEllipseElement>)}
                />
              )}
            </Solid>
          ))}
        </g>
      )
    case "webbed":
      return (
        <g data-pet-part="feet" data-feet="webbed">
          {sides.map((side) => {
            const x = CX + side * dims.rx * 0.36
            const y = bottom
            return (
              <path
                key={side}
                d={`M ${x - 7} ${y} q 1 -5 7 -5 q 6 0 7 5 q -2 1.5 -3.5 0 q -1.75 1.5 -3.5 0 q -1.75 1.5 -3.5 0 q -1.5 1.5 -3.5 0 z`}
                fill={BEAK}
                strokeLinejoin="round"
                {...PET_OUTLINE}
              />
            )
          })}
        </g>
      )
  }
}

function Arms({ traits, dims, ids, bones }: PartProps) {
  const sides = [-1, 1] as const
  const { primary } = bones.palette
  switch (traits.arms) {
    case "none":
      return null
    case "nubs":
      return (
        <g data-pet-part="arms" data-arms="nubs">
          {sides.map((side) => {
            const cx = CX + side * dims.rx * 0.86
            const cy = BODY_CY + dims.ry * 0.3
            return (
              <g key={side} transform={`rotate(${side * -24} ${cx} ${cy})`}>
                <Solid ids={ids} fill={primary} shine={false}>
                  {(p) => (
                    <ellipse
                      cx={cx}
                      cy={cy}
                      rx={4.4}
                      ry={6.4}
                      {...(p as SVGProps<SVGEllipseElement>)}
                    />
                  )}
                </Solid>
              </g>
            )
          })}
        </g>
      )
    case "wings":
      return (
        <g data-pet-part="arms" data-arms="wings">
          {sides.map((side) => {
            const cx = CX + side * dims.rx * 0.88
            const cy = BODY_CY + dims.ry * 0.18
            return (
              <g key={side} transform={`rotate(${side * -18} ${cx} ${cy})`}>
                <Solid ids={ids} fill={primary} shine={false}>
                  {(p) => (
                    <path
                      d={`M ${cx} ${cy - 10} Q ${cx + side * 8} ${cy - 2} ${cx + side * 3} ${cy + 11} Q ${cx - side * 5} ${cy + 2} ${cx} ${cy - 10} Z`}
                      {...(p as SVGProps<SVGPathElement>)}
                    />
                  )}
                </Solid>
              </g>
            )
          })}
        </g>
      )
  }
}

/**
 * Species face trait. A beak for the birds, a muzzle and nose for snouted
 * species; `round`/`blob` add nothing. Drawn under the eyes/mouth (which the
 * parent skin layers on top).
 */
function Face({ traits }: { traits: PetSpeciesTraits }) {
  switch (traits.face) {
    case "beak":
      return (
        <path
          data-pet-part="face"
          data-face="beak"
          d={`M ${CX - 7} 57.5 Q ${CX} 54.5 ${CX + 7} 57.5 Q ${CX} 66 ${CX - 7} 57.5 Z`}
          fill={BEAK}
          strokeLinejoin="round"
          {...PET_OUTLINE}
        />
      )
    case "snout":
      return (
        <g data-pet-part="face" data-face="snout">
          <ellipse cx={CX} cy={63} rx={10.5} ry={7.2} fill="#ffffff" opacity={0.42} />
          <path
            d={`M ${CX - 2.6} 58 Q ${CX} 57 ${CX + 2.6} 58 Q ${CX} 61.6 ${CX - 2.6} 58 Z`}
            fill={INK}
          />
        </g>
      )
    case "round":
    case "blob":
      return null
  }
}

function Hat({ hat, accent, top }: { hat: PetHat; accent: string; top: number }) {
  // Hats sit on the head, sunk a touch into it rather than hovering over it.
  const topY = top + 2
  switch (hat) {
    case "none":
      return null
    case "crown":
      return (
        <path
          data-pet-part="hat"
          data-hat="crown"
          d={`M ${CX - 12} ${topY} l 3 -10 l 4 6 l 5 -9 l 5 9 l 4 -6 l 3 10 z`}
          fill="#f5c542"
          stroke="#caa12f"
          strokeWidth={1}
          strokeLinejoin="round"
        />
      )
    case "tophat":
      return (
        <g data-pet-part="hat" data-hat="tophat" fill="#2a2a33">
          <rect x={CX - 8} y={topY - 14} width={16} height={14} rx={1} />
          <rect x={CX - 8} y={topY - 5} width={16} height={2.6} fill={accent} />
          <rect x={CX - 14} y={topY - 2} width={28} height={4} rx={2} />
        </g>
      )
    case "propeller":
      return (
        <g data-pet-part="hat" data-hat="propeller">
          <path d={`M ${CX - 12} ${topY} a 12 10 0 0 1 24 0 z`} fill={accent} {...PET_OUTLINE} />
          <line x1={CX} y1={topY - 10} x2={CX} y2={topY - 16} stroke="#2a2a33" strokeWidth={1.6} />
          <line
            x1={CX - 8}
            y1={topY - 16}
            x2={CX + 8}
            y2={topY - 16}
            stroke="#2a2a33"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        </g>
      )
    case "halo":
      return (
        <ellipse
          data-pet-part="hat"
          data-hat="halo"
          cx={CX}
          cy={topY - 10}
          rx={12}
          ry={4}
          fill="none"
          stroke="#f5e27a"
          strokeWidth={3}
        />
      )
    case "wizard":
      return (
        <g data-pet-part="hat" data-hat="wizard">
          <path
            d={`M ${CX + 2} ${topY - 22} l -14 22 l 24 0 z`}
            fill="#6d5ae0"
            strokeLinejoin="round"
            {...PET_OUTLINE}
          />
          <path
            d={`M ${CX} ${topY - 8} l 1.4 3 l 3 0.4 l -2.2 2 l 0.6 3 l -2.8 -1.6 l -2.8 1.6 l 0.6 -3 l -2.2 -2 l 3 -0.4 z`}
            fill="#f5e27a"
          />
        </g>
      )
    case "beanie":
      return (
        <g data-pet-part="hat" data-hat="beanie">
          <path d={`M ${CX - 14} ${topY} a 14 12 0 0 1 28 0 z`} fill={accent} {...PET_OUTLINE} />
          <circle cx={CX} cy={topY - 12} r={3} fill={accent} {...PET_OUTLINE} />
        </g>
      )
    case "tinyduck":
      return (
        <g data-pet-part="hat" data-hat="tinyduck">
          <ellipse cx={CX} cy={topY - 4} rx={7} ry={6} fill="#ffd24a" {...PET_OUTLINE} />
          <circle cx={CX + 5} cy={topY - 7} r={3.5} fill="#ffd24a" />
          <path d={`M ${CX + 8} ${topY - 7} l 4 1 l -4 1 z`} fill={BEAK} />
        </g>
      )
  }
}

export function PetBody({ bones }: { bones: PetBones }) {
  const traits = getSpeciesTraits(bones.species)
  const dims = bodyDims(bones, traits)
  const ids = usePetShadeIds()
  const { palette } = bones
  const d = silhouettePath(traits.silhouette, dims)
  const parts: PartProps = { traits, dims, bones, ids }
  // The cap replaces the head's top, so a hat sits on the cap.
  const capTop = traits.feature === "cap" ? headTop(dims) - 8 : headTop(dims)
  return (
    <g
      data-pet-part="body"
      data-species={bones.species}
      data-body-type={bones.bodyType}
      data-silhouette={traits.silhouette}
    >
      <PetShadeDefs ids={ids} />
      {/* Behind the body: tail, ears, shells. */}
      <Tail {...parts} />
      <Ears {...parts} />
      <BackFeature {...parts} />
      {/* Body: fill, belly, then the shared shade/shine and outline. */}
      <path data-pet-part="torso" d={d} fill={palette.primary} />
      {traits.silhouette === "box" ? (
        <rect
          data-pet-part="belly"
          x={CX - dims.rx * 0.58}
          y={BODY_CY - dims.ry * 0.05}
          width={dims.rx * 1.16}
          height={dims.ry * 0.78}
          rx={Math.min(dims.rx, dims.ry) * 0.3}
          fill={palette.secondary}
          opacity={0.9}
        />
      ) : (
        <ellipse
          data-pet-part="belly"
          cx={CX}
          cy={BODY_CY + dims.ry * 0.28}
          rx={dims.rx * 0.6}
          ry={dims.ry * 0.54}
          fill={palette.secondary}
          opacity={0.92}
        />
      )}
      <path d={d} fill={`url(#${ids.shade})`} />
      <path d={d} fill={`url(#${ids.shine})`} />
      <path d={d} fill="none" {...PET_OUTLINE} />
      {/* In front of the body. */}
      <Feet {...parts} />
      <Arms {...parts} />
      {/* Species face trait (beak/snout) — under the eyes/mouth overlay. */}
      <Face traits={traits} />
      {/* Cheeks. */}
      {traits.cheeks && (
        <g data-pet-part="cheeks" fill="#ff8aa0" opacity={0.5}>
          {/* Low enough to clear the wide eyes' whites. */}
          <ellipse cx={CX - 20} cy={60.5} rx={4.6} ry={3.2} />
          <ellipse cx={CX + 20} cy={60.5} rx={4.6} ry={3.2} />
        </g>
      )}
      <FrontFeature {...parts} />
      <Hat hat={bones.hat} accent={palette.accent} top={capTop} />
    </g>
  )
}
