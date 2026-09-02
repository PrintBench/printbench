/**
 * Reading print settings back out of a sliced G-code file.
 *
 * A sliced file already knows almost everything a print profile wants to record
 * — the nozzle, the layer height, the filament, how long it will take — because
 * the slicer wrote it into the comments on the way past. Asking someone to type
 * all of it in again, with the answer sitting in the folder, is busywork.
 *
 * Two comment dialects cover the slicers people actually use:
 *
 *   PrusaSlicer / SuperSlicer / Orca / Bambu   `; key = value`, in a config
 *                                              block at the END of the file
 *   Cura                                       `;KEY:value`, in a header block
 *                                              at the START
 *
 * Hence the (head, tail) signature: this is handed the two ends of the file and
 * never the middle. Sliced G-code runs to hundreds of megabytes of movement
 * commands, and none of it is interesting.
 *
 * The parser is deliberately timid. Unknown keys are ignored, values that do not
 * parse are dropped rather than guessed at, and anything that looks like binary
 * or base64 noise is skipped. Everything here ends up pre-filled into a form a
 * person is about to save, so a field left blank costs them one entry — a field
 * confidently filled in wrong costs them a wrong record they may never notice.
 */

export type ParsedNozzleType = 'brass' | 'hardened_steel' | 'ruby' | 'tungsten_carbide' | 'other'
export type ParsedAdhesion = 'none' | 'skirt' | 'brim' | 'raft'

/** Everything we managed to read. Every field is optional; most files have gaps. */
export interface GcodeMetadata {
  nozzleMm?: number
  nozzleType?: ParsedNozzleType
  layerHeightMm?: number
  material?: string
  filamentBrand?: string
  colorHex?: string
  infillPercent?: number
  wallCount?: number
  supports?: boolean
  adhesion?: ParsedAdhesion
  nozzleTempC?: number
  bedTempC?: number
  durationMin?: number
  filamentUsedG?: number
  filamentCost?: number
  printerName?: string
  slicerName?: string
  slicerVersion?: string
  slicerProfile?: string
  /** The file declared more than one tool or filament; we took the first. */
  multiMaterial?: boolean
}

/**
 * Binary G-code starts with this. It is heatshrink-compressed blocks, not text,
 * and running a comment parser over it produces confident nonsense.
 */
const BGCODE_MAGIC = 'GCDE'

/**
 * A plausible config key: letters, digits and the punctuation slicers actually
 * use. This is the guard that keeps base64 thumbnail payloads and `;SETTING_3`
 * blobs — both of which contain `=` — out of the map.
 */
const PLAUSIBLE_KEY = /^[a-z0-9_ .()[\]%/-]{1,60}$/

export function parseGcodeMetadata(head: string, tail: string): GcodeMetadata {
  // Nothing text-shaped to read, and pretending otherwise invents values.
  if (head.startsWith(BGCODE_MAGIC)) return {}

  const config = collectConfig(head, tail)
  const out: GcodeMetadata = {}

  // --- nozzle -------------------------------------------------------------
  const nozzle = firstOf(config, 'nozzle_diameter', 'nozzle_diameter_0')
  if (nozzle) {
    const value = number(nozzle.first)
    // Above 2 mm it is not a nozzle, it is a misread field.
    if (value != null && value > 0 && value <= 2) out.nozzleMm = value
    if (nozzle.multiple) out.multiMaterial = true
  }

  const nozzleType = firstOf(config, 'nozzle_type')
  if (nozzleType) out.nozzleType = mapNozzleType(nozzleType.first)

  // --- layers and walls ---------------------------------------------------
  const layer = number(config.get('layer_height'))
  if (layer != null && layer > 0 && layer <= 5) out.layerHeightMm = layer

  // `perimeters` is PrusaSlicer, `wall_loops` is Orca and Bambu.
  const walls = integer(config.get('perimeters') ?? config.get('wall_loops'))
  if (walls != null && walls >= 0 && walls <= 100) out.wallCount = walls

  const infill = percent(config.get('fill_density') ?? config.get('sparse_infill_density'))
  if (infill != null) out.infillPercent = infill

  // --- filament -----------------------------------------------------------
  const material = firstOf(config, 'filament_type')
  if (material && !isPlaceholder(material.first)) {
    out.material = material.first
    if (material.multiple) out.multiMaterial = true
  }

  const vendor = firstOf(config, 'filament_vendor')
  if (vendor && !isPlaceholder(vendor.first)) out.filamentBrand = vendor.first

  const colour = firstOf(config, 'filament_colour', 'filament_color', 'extruder_colour')
  // Checked against the same shape the print service validates, so a value that
  // would be rejected on save never reaches the form.
  if (colour && /^#[0-9a-f]{6}$/i.test(colour.first)) out.colorHex = colour.first.toLowerCase()

  /*
   * `; total filament cost = 1.23` is what this print cost. The `filament_cost`
   * config key is cost per KILOGRAM, so reading that one would overstate a
   * 12 g print by about eighty times.
   */
  const cost = number(config.get('total filament cost'))
  if (cost != null && cost >= 0) out.filamentCost = cost

  /*
   * Grams only. Cura reports filament as a LENGTH, and converting it would mean
   * assuming a diameter and a density — two guesses to manufacture a number that
   * looks measured. Left blank instead.
   */
  const grams = number(
    config.get('total filament used [g]') ??
      config.get('filament used [g]') ??
      config.get('total filament weight [g]'),
  )
  if (grams != null && grams >= 0) out.filamentUsedG = grams

  // --- temperatures -------------------------------------------------------
  const nozzleTempValue = integer(firstOf(config, 'nozzle_temperature', 'temperature')?.first)
  if (nozzleTempValue != null && nozzleTempValue > 0 && nozzleTempValue <= 500) {
    out.nozzleTempC = nozzleTempValue
  }

  const bedTempValue = integer(
    firstOf(config, 'bed_temperature', 'hot_plate_temp', 'first_layer_bed_temperature')?.first,
  )
  if (bedTempValue != null && bedTempValue > 0 && bedTempValue <= 500) out.bedTempC = bedTempValue

  // --- supports and adhesion ----------------------------------------------
  const supports = boolean(config.get('support_material') ?? config.get('enable_support'))
  if (supports != null) out.supports = supports

  const adhesion = readAdhesion(config)
  if (adhesion) out.adhesion = adhesion

  // --- time ---------------------------------------------------------------
  const duration = readDuration(config)
  if (duration != null) out.durationMin = duration

  // --- provenance ---------------------------------------------------------
  const printer =
    config.get('printer_model') ??
    config.get('printer_settings_id') ??
    config.get('target_machine.name')
  if (printer && !isPlaceholder(printer)) out.printerName = printer

  const profile = config.get('print_settings_id')
  if (profile && !isPlaceholder(profile)) out.slicerProfile = profile

  const generator = config.get('__generator')
  if (generator) {
    const parsed = parseGenerator(generator)
    if (parsed.name) out.slicerName = parsed.name
    if (parsed.version) out.slicerVersion = parsed.version
  }

  return out
}

/**
 * Flattens both ends of the file into one key/value map.
 *
 * The tail is read second and wins, because in the Prusa family the block at the
 * end of the file is the authoritative config — the header carries only a few
 * summary lines, and where they disagree the footer is right.
 */
function collectConfig(head: string, tail: string): Map<string, string> {
  const config = new Map<string, string>()
  for (const chunk of [head, tail]) {
    for (const raw of chunk.split(/\r?\n/)) {
      readLine(raw, config)
    }
  }
  return config
}

function readLine(raw: string, config: Map<string, string>): void {
  const line = raw.trim()
  if (!line.startsWith(';')) return

  const body = line.slice(1).trim()
  if (!body) return

  /*
   * Cura's serialised settings blob. Megabytes of base64 across thousands of
   * lines, and it contains `=`, so without this it would be parsed key by key.
   */
  if (body.startsWith('SETTING_')) return
  // PrusaSlicer's embedded PNG preview, likewise base64.
  if (/^thumbnail(_[A-Z]+)? (begin|end)/i.test(body)) return

  /*
   * Handled before the split: "generated by PrusaSlicer 2.8.0 on 2024-01-01 at
   * 12:00:00" has no `=` and several `:`, so the generic parser would take
   * everything up to the first colon as a key.
   */
  const generated = /^generated (?:by|with)\s+(.+)$/i.exec(body)
  if (generated?.[1]) {
    config.set('__generator', generated[1].trim())
    return
  }

  const cut = splitPoint(body)
  if (cut < 0) return

  const key = body.slice(0, cut).trim().toLowerCase()
  const value = clean(body.slice(cut + 1))
  if (!key || !value || !PLAUSIBLE_KEY.test(key)) return

  config.set(key, value)

  /*
   * Cura spaces its keys where the Prusa family underscores them — "Layer
   * height" against "layer_height" — so the same setting is stored under both
   * spellings and every lookup below can name just one of them.
   */
  const underscored = key.replace(/ /g, '_')
  if (underscored !== key) config.set(underscored, value)
}

/** Index of the separator: `=` if the line has one, otherwise the first `:`. */
function splitPoint(body: string): number {
  const equals = body.indexOf('=')
  if (equals >= 0) return equals
  return body.indexOf(':')
}

/** Strips the quotes and whitespace slicers wrap values in. */
function clean(value: string): string {
  return value
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim()
}

/**
 * Reads a value that may carry one entry per extruder.
 *
 * `nozzle_diameter = 0.4,0.4` and `filament_type = "PLA";"PETG"` are both a
 * list. We take the first and flag it, rather than silently recording a
 * multi-material print as if it used one filament.
 */
function firstOf(
  config: Map<string, string>,
  ...keys: string[]
): { first: string; multiple: boolean } | undefined {
  for (const key of keys) {
    const raw = config.get(key)
    if (raw == null) continue
    const parts = raw
      .split(/[,;]/)
      .map(clean)
      .filter((part) => part.length > 0)
    const first = parts[0]
    if (first === undefined) continue
    return { first, multiple: parts.length > 1 }
  }
  return undefined
}

function number(value: string | undefined): number | null {
  if (value == null) return null
  // Leading number only, so "1.23g" and "15%" both read.
  const match = /^-?\d+(?:\.\d+)?/.exec(value.trim())
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function integer(value: string | undefined): number | null {
  const parsed = number(value)
  return parsed == null ? null : Math.round(parsed)
}

function percent(value: string | undefined): number | null {
  const parsed = number(value)
  if (parsed == null) return null
  // Anything outside 0-100 is not a percentage we understand.
  return parsed >= 0 && parsed <= 100 ? Math.round(parsed) : null
}

function boolean(value: string | undefined): boolean | null {
  if (value == null) return null
  const text = value.trim().toLowerCase()
  if (text === '1' || text === 'true') return true
  if (text === '0' || text === 'false') return false
  return null
}

/**
 * Slicers write "unknown", "undefine" and "" for a field they have no answer
 * for. Passing those through would fill the form with the word "undefine".
 */
function isPlaceholder(value: string): boolean {
  const text = value.trim().toLowerCase()
  return text === '' || text === 'undefine' || text === 'undefined' || text === 'unknown'
}

function mapNozzleType(value: string): ParsedNozzleType | undefined {
  const text = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (isPlaceholder(text)) return undefined
  if (text === 'brass') return 'brass'
  if (text === 'hardened_steel') return 'hardened_steel'
  if (text === 'ruby') return 'ruby'
  if (text === 'tungsten_carbide') return 'tungsten_carbide'
  // A real nozzle we have no name for is still worth recording as "other".
  return 'other'
}

/**
 * Works out the adhesion aid from whichever keys the slicer happened to write.
 *
 * Checked most-specific first: a raft makes the brim setting irrelevant, and a
 * brim makes the skirt count moot.
 */
function readAdhesion(config: Map<string, string>): ParsedAdhesion | undefined {
  const cura = config.get('adhesion_type')
  if (cura) {
    const text = cura.trim().toLowerCase()
    if (text === 'raft' || text === 'brim' || text === 'skirt' || text === 'none') return text
  }

  const rafts = integer(config.get('raft_layers'))
  if (rafts != null && rafts > 0) return 'raft'

  const brimType = config.get('brim_type')?.trim().toLowerCase()
  const brimWidth = number(config.get('brim_width'))
  if ((brimType && brimType !== 'no_brim' && brimType !== 'none') || (brimWidth ?? 0) > 0) {
    return 'brim'
  }

  const skirts = integer(config.get('skirts') ?? config.get('skirt_loops'))
  if (skirts != null && skirts > 0) return 'skirt'

  /*
   * Only claim "none" if the file actually discussed adhesion. Otherwise this is
   * an unanswered question, not an answer of "none".
   */
  const discussed =
    rafts != null || brimType != null || brimWidth != null || skirts != null || cura != null
  return discussed ? 'none' : undefined
}

/** Estimated print time, in whole minutes. */
function readDuration(config: Map<string, string>): number | null {
  // Cura, in seconds.
  const seconds = number(config.get('time'))
  if (seconds != null && seconds > 0) return Math.round(seconds / 60)

  const text =
    config.get('estimated printing time (normal mode)') ??
    config.get('estimated printing time') ??
    config.get('model printing time') ??
    config.get('total estimated time')
  return text ? parseDuration(text) : null
}

/** "1d 2h 3m 4s" in any combination, to whole minutes. */
export function parseDuration(text: string): number | null {
  const match = /^(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/i.exec(text.trim())
  if (!match) return null

  const [, days, hours, minutes, secs] = match
  if (!days && !hours && !minutes && !secs) return null

  const total =
    Number(days ?? 0) * 1440 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0) +
    Number(secs ?? 0) / 60
  return total > 0 ? Math.round(total) : null
}

/** "PrusaSlicer 2.8.0+win64 on 2024-01-01" -> name and version. */
function parseGenerator(text: string): { name?: string; version?: string } {
  const match = /^([A-Za-z][\w .-]*?)[\s_-]*v?(\d+\.\d+(?:\.\d+)?)/.exec(text.trim())
  if (!match) {
    const name = text.split(/\s+/)[0]
    return name ? { name } : {}
  }
  // Cura calls itself Cura_SteamEngine in the file; nobody else does.
  const name = match[1]!.trim().replace(/_SteamEngine$/i, '')
  return { name, version: match[2] }
}
