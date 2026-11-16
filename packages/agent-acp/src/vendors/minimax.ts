import type { AcpVendorProfile } from "../vendor-profile"

/** Permission authority is configured by MiniMaxAcpAdapter on its own process. */
export const minimaxAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "minimax-code",
  label: "MiniMax Code",
  commandNames: ["mcode"],
  launch: {
    id: "minimax-code",
    match: { kind: "base", values: ["mcode"] },
    stateRoots: [".minimax"],
    // MiniMax resolves its first nonempty directory alias before ~/.minimax.
    relocation: {
      env: ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"],
      skipEmpty: true,
      default: ".minimax",
      temp: "tmp",
    },
    isolation: {
      env: { MINIMAX_DATA_DIR: "minimax", MAVIS_DATA_DIR: "minimax" },
      denyReadable: [".minimax"],
    },
  },
  permissionModes: {
    toNative: (mode) => {
      if (mode === "acceptEdits" || mode === "dontAsk")
        throw new Error(`MiniMax ACP cannot enforce ${mode}`)
      return mode === "plan" ? "plan" : "default"
    },
    toCanonical: (nativeMode, current) =>
      nativeMode === "plan" ? "plan" : current && current !== "plan" ? current : "default",
  },
  fork: {
    inheritsSourceWorkspace: true,
    requiresDistinctSessionId: true,
    rebindsMcpByReload: false,
  },
})
