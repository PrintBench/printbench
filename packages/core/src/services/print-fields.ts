/**
 * The fixed vocabulary of a print profile, and how to write it in English.
 *
 * Its own module, and its own `@pb/core/prints` export, because the log-a-print
 * form is a client component: importing these from the package barrel would drag
 * `fs`, `pg` and the S3 client into the browser bundle along with them. Same
 * reason `@pb/core/policy` and `@pb/core/health` exist.
 *
 * Nothing here may import anything that touches node or the database.
 */

/**
 * What the nozzle is made of — a different question from its diameter, and the
 * one that decides whether an abrasive filament ruins the hot end.
 */
export const NOZZLE_TYPES = [
  'brass',
  'hardened_steel',
  'ruby',
  'tungsten_carbide',
  'other',
] as const
export type NozzleType = (typeof NOZZLE_TYPES)[number]

export const BED_ADHESIONS = ['none', 'skirt', 'brim', 'raft'] as const
export type BedAdhesion = (typeof BED_ADHESIONS)[number]

/*
 * Typed as a complete Record, so adding a value to either enum above without
 * giving it wording is a compile error rather than a blank dropdown option.
 */
export const NOZZLE_TYPE_LABELS: Record<NozzleType, string> = {
  brass: 'Brass',
  hardened_steel: 'Hardened steel',
  ruby: 'Ruby',
  tungsten_carbide: 'Tungsten carbide',
  other: 'Other',
}

export const BED_ADHESION_LABELS: Record<BedAdhesion, string> = {
  none: 'None',
  skirt: 'Skirt',
  brim: 'Brim',
  raft: 'Raft',
}
