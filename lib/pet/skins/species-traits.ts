// Per-species visual traits. Instead of 18 bespoke SVGs, one parametric skeleton
// reads these traits (+ the bones palette) to produce distinct silhouettes. This
// keeps the renderer single-file and lets bones drive appearance directly.

import type { PetSpecies } from "@/types/pet"

export type PetEarType =
  "none" | "cat" | "rabbit" | "round" | "tuft" | "fin" | "antenna" | "gills" | "horns"
export type PetTailType = "none" | "curl" | "puff" | "point" | "fan" | "bushy"
export type PetFaceType = "round" | "beak" | "snout" | "blob"
/** The outline the body is cut from. */
export type PetSilhouette = "mochi" | "box" | "ghost" | "tentacles"
/** What the pet stands on. */
export type PetFeetType = "paws" | "webbed" | "none"
/** What sits at its sides. */
export type PetArmsType = "nubs" | "wings" | "none"
/** One signature feature that names the species at a glance. */
export type PetSpeciesFeature = "none" | "cap" | "spines" | "shell" | "spiral-shell" | "puddle"

export interface PetSpeciesTraits {
  ears: PetEarType
  tail: PetTailType
  face: PetFaceType
  /** Cheeks/blush accent for cuteness. */
  cheeks: boolean
  /** A floor on body roundness (0 = can be tall, 1 = always round). */
  roundness: number
  silhouette: PetSilhouette
  feet: PetFeetType
  arms: PetArmsType
  feature: PetSpeciesFeature
}

const TRAITS: Record<PetSpecies, PetSpeciesTraits> = {
  duck: {
    ears: "none",
    tail: "fan",
    face: "beak",
    cheeks: true,
    roundness: 0.7,
    silhouette: "mochi",
    feet: "webbed",
    arms: "wings",
    feature: "none",
  },
  cat: {
    ears: "cat",
    tail: "curl",
    face: "snout",
    cheeks: true,
    roundness: 0.5,
    silhouette: "mochi",
    feet: "paws",
    arms: "nubs",
    feature: "none",
  },
  rabbit: {
    ears: "rabbit",
    tail: "puff",
    face: "round",
    cheeks: true,
    roundness: 0.6,
    silhouette: "mochi",
    feet: "paws",
    arms: "nubs",
    feature: "none",
  },
  owl: {
    ears: "tuft",
    tail: "none",
    face: "beak",
    cheeks: false,
    roundness: 0.8,
    silhouette: "mochi",
    feet: "paws",
    arms: "wings",
    feature: "none",
  },
  penguin: {
    ears: "none",
    tail: "none",
    face: "beak",
    cheeks: true,
    roundness: 0.6,
    silhouette: "mochi",
    feet: "webbed",
    arms: "wings",
    feature: "none",
  },
  turtle: {
    ears: "none",
    tail: "point",
    face: "snout",
    cheeks: false,
    roundness: 0.9,
    silhouette: "mochi",
    feet: "paws",
    arms: "nubs",
    feature: "shell",
  },
  fox: {
    ears: "cat",
    tail: "bushy",
    face: "snout",
    cheeks: true,
    roundness: 0.4,
    silhouette: "mochi",
    feet: "paws",
    arms: "nubs",
    feature: "none",
  },
  dragon: {
    ears: "horns",
    tail: "point",
    face: "snout",
    cheeks: false,
    roundness: 0.3,
    silhouette: "mochi",
    feet: "paws",
    arms: "wings",
    feature: "none",
  },
  axolotl: {
    ears: "gills",
    tail: "fan",
    face: "round",
    cheeks: true,
    roundness: 0.7,
    silhouette: "mochi",
    feet: "paws",
    arms: "nubs",
    feature: "none",
  },
  blob: {
    ears: "none",
    tail: "none",
    face: "blob",
    cheeks: true,
    roundness: 1,
    silhouette: "mochi",
    feet: "none",
    arms: "none",
    feature: "puddle",
  },
  cactus: {
    ears: "none",
    tail: "none",
    face: "round",
    cheeks: true,
    roundness: 0.4,
    silhouette: "box",
    feet: "none",
    arms: "none",
    feature: "spines",
  },
  mushroom: {
    ears: "none",
    tail: "none",
    face: "round",
    cheeks: true,
    roundness: 0.5,
    silhouette: "mochi",
    feet: "paws",
    arms: "none",
    feature: "cap",
  },
  capybara: {
    ears: "round",
    tail: "none",
    face: "snout",
    cheeks: false,
    roundness: 0.5,
    silhouette: "mochi",
    feet: "paws",
    arms: "nubs",
    feature: "none",
  },
  robot: {
    ears: "antenna",
    tail: "none",
    face: "round",
    cheeks: false,
    roundness: 0.2,
    silhouette: "box",
    feet: "paws",
    arms: "nubs",
    feature: "none",
  },
  ghost: {
    ears: "none",
    tail: "none",
    face: "blob",
    cheeks: true,
    roundness: 0.9,
    silhouette: "ghost",
    feet: "none",
    arms: "nubs",
    feature: "none",
  },
  octopus: {
    ears: "none",
    tail: "none",
    face: "round",
    cheeks: true,
    roundness: 0.8,
    silhouette: "tentacles",
    feet: "none",
    arms: "none",
    feature: "none",
  },
  snail: {
    ears: "antenna",
    tail: "none",
    face: "round",
    cheeks: true,
    roundness: 0.7,
    silhouette: "mochi",
    feet: "none",
    arms: "none",
    feature: "spiral-shell",
  },
  chonk: {
    ears: "round",
    tail: "puff",
    face: "round",
    cheeks: true,
    roundness: 0.95,
    silhouette: "mochi",
    feet: "paws",
    arms: "nubs",
    feature: "none",
  },
}

export function getSpeciesTraits(species: PetSpecies): PetSpeciesTraits {
  return TRAITS[species]
}

/** All species keys — useful for the dex grid and exhaustive tests. */
export const ALL_PET_SPECIES = Object.keys(TRAITS) as PetSpecies[]
