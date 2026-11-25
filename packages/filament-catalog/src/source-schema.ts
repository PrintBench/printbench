import { z } from 'zod'

/*
 * The shape of Open Filament Database's `all.json`, as far as PrintBench relies
 * on it.
 *
 * Every record is a loose object on purpose: upstream adds fields often
 * (sustainability, mechanical data and container details all arrived within a
 * few months), and a new field must never break an update. Anything not named
 * here is carried through to the row's `extra` column instead of being lost.
 *
 * What IS named here is checked strictly. A field changing type means our
 * reading of the data is wrong, and the update script should stop rather than
 * ship a catalogue we half understand.
 */

const id = z.string().min(1)
const text = z.string().nullish()
const num = z.number().nullish()
const flag = z.boolean().nullish()
const countries = z.array(z.string()).nullish()

export const sourceBrand = z.looseObject({
  uuid: id,
  id,
  slug: id,
  name: z.string().min(1),
  website: text,
  logo_name: text,
  origin: text,
  discontinued: flag,
  parent_brand_id: text,
})

export const sourceMaterial = z.looseObject({
  uuid: id,
  id,
  slug: id,
  brand_id: id,
  material: z.string().min(1),
  material_class: text,
  default_max_dry_temperature: num,
  default_slicer_settings: z.record(z.string(), z.unknown()).nullish(),
})

export const sourceFilament = z.looseObject({
  uuid: id,
  id,
  slug: id,
  brand_id: id,
  material_id: id,
  name: z.string().min(1),
  material: z.string().min(1),
  density: num,
  diameter_tolerance: num,
  min_print_temperature: num,
  max_print_temperature: num,
  preheat_temperature: num,
  min_bed_temperature: num,
  max_bed_temperature: num,
  chamber_temperature: num,
  min_chamber_temperature: num,
  max_chamber_temperature: num,
  dry_temperature: num,
  dry_time: num,
  max_dry_temperature: num,
  enclosure: text,
  min_nozzle_diameter: num,
  min_print_speed: num,
  max_print_speed: num,
  min_fan_speed: num,
  max_fan_speed: num,
  max_volumetric_speed: num,
  shore_hardness_a: num,
  shore_hardness_d: num,
  data_sheet_url: text,
  safety_sheet_url: text,
  slicer_settings: z.record(z.string(), z.unknown()).nullish(),
  certifications: z.array(z.string()).nullish(),
  discontinued: flag,
})

export const sourceVariant = z.looseObject({
  uuid: id,
  id,
  slug: id,
  filament_id: id,
  name: z.string().min(1),
  color_hex: text,
  color_hexes: z.array(z.string()).nullish(),
  traits: z.record(z.string(), z.unknown()).nullish(),
  transmission_distance: num,
  discontinued: flag,
})

export const sourceSize = z.looseObject({
  uuid: id,
  id,
  variant_id: id,
  filament_weight: num,
  diameter: num,
  empty_spool_weight: num,
  spool_core_diameter: num,
  spool_refill: flag,
  article_number: text,
  gtin: text,
  container_material: text,
  discontinued: flag,
})

export const sourceStore = z.looseObject({
  uuid: id,
  id,
  slug: id,
  name: z.string().min(1),
  storefront_url: text,
  logo_name: text,
  ships_from: countries,
  ships_to: countries,
})

export const sourcePurchaseLink = z.looseObject({
  id,
  size_id: id,
  store_id: id,
  url: z.string().min(1),
  spool_refill: flag,
  affiliate: flag,
  ships_from: countries,
  ships_to: countries,
})

export const sourceDataset = z.looseObject({
  version: z.string().min(1),
  generated_at: z.string().min(1),
  brands: z.array(sourceBrand),
  materials: z.array(sourceMaterial),
  filaments: z.array(sourceFilament),
  variants: z.array(sourceVariant),
  sizes: z.array(sourceSize),
  stores: z.array(sourceStore),
  purchase_links: z.array(sourcePurchaseLink),
})

export type SourceDataset = z.infer<typeof sourceDataset>
export type SourceBrand = z.infer<typeof sourceBrand>
export type SourceStore = z.infer<typeof sourceStore>
