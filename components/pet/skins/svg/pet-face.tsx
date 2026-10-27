// Face primitives for the SVG skin: eyes (6 shapes) and mouth (7 shapes).
// Presentational and deterministic — they draw a given expression at fixed
// coordinates in the 100×100 pet viewBox. Animation (blink, emotion swaps) is
// driven by the parent skin; these just render the current frame.

import type { PetEyes } from "@/types/pet"
import type { PetMouthShape } from "@/lib/pet/animation/motion-spec"

const LEFT_EYE_X = 38
const RIGHT_EYE_X = 62
const EYE_Y = 50
const INK = "var(--pet-ink, #2a2a33)"

/** The glint that makes an eye read as wet and alive rather than a dot. */
function Catchlight({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return <circle data-pet-part="catchlight" cx={cx} cy={cy} r={r} fill="#ffffff" />
}

function Eye({ cx, kind, wink }: { cx: number; kind: PetEyes; wink?: boolean }) {
  // A winking pet closes its right eye into an arc.
  if (wink) {
    return (
      <path
        d={`M ${cx - 5} ${EYE_Y} q 5 5 10 0`}
        stroke={INK}
        strokeWidth={2.5}
        fill="none"
        strokeLinecap="round"
      />
    )
  }
  switch (kind) {
    case "dot":
      return (
        <g>
          <ellipse cx={cx} cy={EYE_Y} rx={4.2} ry={4.6} fill={INK} />
          <Catchlight cx={cx + 1.5} cy={EYE_Y - 1.7} r={1.4} />
        </g>
      )
    case "wide":
      return (
        <g>
          <circle cx={cx} cy={EYE_Y} r={6.5} fill="#fff" stroke={INK} strokeWidth={1.5} />
          <circle cx={cx} cy={EYE_Y + 1} r={3.4} fill={INK} />
          <Catchlight cx={cx + 1.3} cy={EYE_Y - 0.4} r={1.2} />
        </g>
      )
    case "sleepy":
      return (
        <path
          d={`M ${cx - 5} ${EYE_Y} q 5 4 10 0`}
          stroke={INK}
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
        />
      )
    case "wink":
      return (
        <path
          d={`M ${cx - 5} ${EYE_Y} q 5 5 10 0`}
          stroke={INK}
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
        />
      )
    case "star":
      return (
        <path
          d={`M ${cx} ${EYE_Y - 6} l 1.6 3.6 l 4 0.4 l -3 2.6 l 1 3.8 l -3.6 -2 l -3.6 2 l 1 -3.8 l -3 -2.6 l 4 -0.4 z`}
          fill={INK}
        />
      )
    case "spiral":
      return (
        <path
          d={`M ${cx} ${EYE_Y} m -5 0 a 5 5 0 1 1 5 5 a 3 3 0 1 1 -3 -3`}
          stroke={INK}
          strokeWidth={1.6}
          fill="none"
        />
      )
  }
}

export function PetEyesGroup({ kind }: { kind: PetEyes }) {
  return (
    <g data-pet-part="eyes" data-eyes={kind}>
      <Eye cx={LEFT_EYE_X} kind={kind} />
      <Eye cx={RIGHT_EYE_X} kind={kind} wink={kind === "wink"} />
    </g>
  )
}

const MOUTH_Y = 66

export function PetMouth({ shape }: { shape: PetMouthShape }) {
  const path = (() => {
    switch (shape) {
      case "neutral":
      case "flat":
        return (
          <line
            x1={44}
            y1={MOUTH_Y}
            x2={56}
            y2={MOUTH_Y}
            stroke={INK}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        )
      case "smile":
        return (
          <path
            d={`M 43 ${MOUTH_Y} q 7 6 14 0`}
            stroke={INK}
            strokeWidth={2.4}
            fill="none"
            strokeLinecap="round"
          />
        )
      case "grin":
        return <path d={`M 41 ${MOUTH_Y - 1} q 9 9 18 0 q -9 4 -18 0 z`} fill={INK} />
      case "frown":
        return (
          <path
            d={`M 43 ${MOUTH_Y + 3} q 7 -6 14 0`}
            stroke={INK}
            strokeWidth={2.4}
            fill="none"
            strokeLinecap="round"
          />
        )
      case "open":
        return <ellipse cx={50} cy={MOUTH_Y + 1} rx={6} ry={7} fill={INK} />
      case "o":
        return <circle cx={50} cy={MOUTH_Y + 1} r={3.6} fill={INK} />
    }
  })()
  return (
    <g data-pet-part="mouth" data-mouth={shape}>
      {path}
    </g>
  )
}
