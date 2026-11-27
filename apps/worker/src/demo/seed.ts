import { sql } from 'drizzle-orm'
import type { Database } from '@pb/db'
import {
  addModelToCollection,
  createCollection,
  createRequest,
  createSpool,
  logPrint,
  setRequestStatus,
  setTagColor,
  toggleLike,
} from '@pb/core'

/**
 * The demo's shop window: everything a scan of demo-library/ cannot produce.
 *
 * Creators, tags, licences and notes come from the library's own
 * .printbench.json sidecars, which a scan applies to every new model. This adds
 * what lives only in the database (collections, likes, filament stock, print
 * history and the queue) through the same services the app calls, so the seed
 * cannot drift from what the UI would have written.
 *
 * Dates are relative to the moment of seeding, so after every nightly reset the
 * history still reads "two days ago" rather than ageing into last month.
 */
export async function seedDemo(db: Database, userId: string, now = new Date()): Promise<void> {
  const mid = await modelLookup(db)
  const day = 86_400_000
  const ago = (days: number, hour = 14) => {
    const at = new Date(now.getTime() - days * day)
    at.setUTCHours(hour, 10, 0, 0)
    return at
  }

  for (const [slug, color] of Object.entries(TAG_COLORS)) {
    const tag = await db.execute<{ id: string }>(sql`SELECT id FROM tags WHERE slug = ${slug}`)
    if (tag.rows[0]) await setTagColor(db, tag.rows[0].id, color)
  }

  for (const [name, collection] of Object.entries(COLLECTIONS)) {
    const created = await createCollection(db, { name, caption: collection.caption })
    for (const model of collection.items) await addModelToCollection(db, created.id, mid(model))
  }

  for (const model of LIKED) await toggleLike(db, userId, mid(model))

  const spools: Record<string, string> = {}
  for (const spool of SPOOLS) {
    spools[spool.key] = await createSpool(
      db,
      {
        filament: spool.filament,
        label: spool.label,
        nominalWeightG: 1000,
        remainingG: spool.remaining,
        purchaseCost: spool.cost,
        location: spool.label,
        lowStockG: 100,
      },
      userId,
    )
  }

  for (const print of PRINTS) {
    const startedAt = ago(print.daysAgo, 9 + (print.daysAgo % 6))
    const filament = SPOOLS.find((spool) => spool.key === print.spool)!.filament
    await logPrint(db, {
      modelId: mid(print.model),
      userId,
      printerName: print.printer,
      material: filament.material,
      colorHex: filament.colorHex,
      colorName: filament.colorName,
      filamentBrand: filament.brand,
      layerHeightMm: 0.2,
      nozzleMm: 0.4,
      nozzleType: 'brass',
      infillPercent: print.spool === 'orange' ? 40 : 15,
      wallCount: 3,
      supports: print.supports,
      adhesion: print.status === 'failed' ? 'none' : 'skirt',
      nozzleTempC: filament.nozzleTempC,
      bedTempC: filament.bedTempC,
      slicerName: print.slicer,
      status: print.status ?? 'success',
      startedAt,
      finishedAt: new Date(startedAt.getTime() + print.hours * 3_600_000),
      durationMin: Math.round(print.hours * 60),
      filamentUsedG: print.grams,
      filamentUsage: [{ spoolId: spools[print.spool]!, grams: print.grams }],
      rating: print.rating,
      notes: print.notes || null,
    })
  }

  for (const request of REQUESTS) {
    const { id } = await createRequest(
      db,
      {
        title: request.title,
        modelId: request.model ? mid(request.model) : null,
        requestedBy: request.by,
        quantity: request.quantity,
        priority: request.priority,
        material: request.material ?? null,
        colorHex: request.colorHex ?? null,
        notes: request.notes ?? null,
        dueAt: request.dueInDays ? new Date(now.getTime() + request.dueInDays * day) : null,
      },
      userId,
    )
    if (request.status) await setRequestStatus(db, id, request.status, { userId })
  }
}

/**
 * Finds a model by its folder, loosely.
 *
 * Folder names and display names differ in punctuation ("Low-poly Planter"),
 * so both sides are reduced to letters, digits and slashes. A miss throws:
 * a seed that silently skipped a model would ship a half-dressed shop window.
 */
async function modelLookup(db: Database): Promise<(modelPath: string) => string> {
  const rows = await db.execute<{ id: string; path: string }>(sql`SELECT id, path FROM models`)
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9/]+/g, '')
  const byPath = new Map(rows.rows.map((row) => [normalise(row.path), row.id]))
  return (modelPath) => {
    const id = byPath.get(normalise(modelPath))
    if (!id) throw new Error(`[demo] seed expects a model at "${modelPath}"`)
    return id
  }
}

const TAG_COLORS: Record<string, string> = {
  functional: '#3b82f6',
  gridfinity: '#06b6d4',
  organiser: '#8b5cf6',
  workshop: '#f59e0b',
  desk: '#10b981',
  home: '#ec4899',
  vase: '#14b8a6',
  'vase-mode': '#0ea5e9',
  planter: '#84cc16',
  tabletop: '#ef4444',
  terrain: '#a16207',
  chess: '#6366f1',
  gift: '#f43f5e',
  fidget: '#d946ef',
  toy: '#f97316',
  presupported: '#22c55e',
  'quick-print': '#eab308',
  'no-supports': '#64748b',
}

const COLLECTIONS: Record<string, { caption: string; items: string[] }> = {
  'Workshop essentials': {
    caption: 'Bins, trays and holders that keep the bench tidy.',
    items: [
      'Functional/Gridfinity Bin 2x1',
      'Functional/Gridfinity Bin 3x2',
      'Functional/Gridfinity Bin 4x2',
      'Functional/Drawer Organiser',
      'Functional/Spool Holder',
      'Functional/Hex Bit Holder',
    ],
  },
  'Tabletop night': {
    caption: 'Terrain and pieces for the weekly game.',
    items: [
      'Tabletop/Hill Terrain Tile',
      'Tabletop/Ruined Tower',
      'Tabletop/Chess Pawn',
      'Tabletop/Dice Tower',
    ],
  },
  'Planters and vases': {
    caption: 'Spiral, faceted and slender, mostly in vase mode.',
    items: [
      'Home & Garden/Spiral Vase',
      'Home & Garden/Low Poly Planter',
      'Home & Garden/Bud Vase',
      'Home & Garden/Succulent Pot Set',
    ],
  },
  'Gift ideas': {
    caption: 'Quick prints that make good presents.',
    items: [
      'Toys & Gifts/Heart Keychain',
      'Toys & Gifts/Torus Knot Pendant',
      'Toys & Gifts/Fidget Gear Set',
      'Toys & Gifts/Twisted Tower',
      'Toys & Gifts/Rocket Shelf Ornament',
    ],
  },
}

const LIKED = [
  'Home & Garden/Spiral Vase',
  'Toys & Gifts/Torus Knot Pendant',
  'Tabletop/Hill Terrain Tile',
  'Functional/Gridfinity Bin 3x2',
  'Toys & Gifts/Twisted Tower',
  'Tabletop/Chess Pawn',
]

const SPOOLS = [
  {
    key: 'black',
    filament: {
      name: 'Galaxy Black',
      brand: 'Prusament',
      material: 'PLA',
      colorName: 'Galaxy Black',
      colorHex: '#23262f',
      nozzleTempC: 215,
      bedTempC: 60,
    },
    remaining: 640,
    cost: 29.99,
    label: 'Shelf A1',
  },
  {
    key: 'sage',
    filament: {
      name: 'PolyTerra Sage Green',
      brand: 'Polymaker',
      material: 'PLA',
      colorName: 'Sage Green',
      colorHex: '#8fae8b',
      nozzleTempC: 210,
      bedTempC: 55,
    },
    remaining: 820,
    cost: 22.5,
    label: 'Shelf A2',
  },
  {
    key: 'orange',
    filament: {
      name: 'PETG HF Orange',
      brand: 'Bambu Lab',
      material: 'PETG',
      colorName: 'Orange',
      colorHex: '#f2701d',
      nozzleTempC: 245,
      bedTempC: 75,
    },
    remaining: 390,
    cost: 24.99,
    label: 'Dry box',
  },
  {
    key: 'white',
    filament: {
      name: 'PLA+ White',
      brand: 'eSun',
      material: 'PLA+',
      colorName: 'Bone White',
      colorHex: '#ece9e1',
      nozzleTempC: 215,
      bedTempC: 60,
    },
    remaining: 960,
    cost: 19.99,
    label: 'Shelf B1',
  },
  {
    key: 'gold',
    filament: {
      name: 'Silk Gold',
      brand: 'Overture',
      material: 'PLA',
      colorName: 'Silk Gold',
      colorHex: '#d4a537',
      nozzleTempC: 220,
      bedTempC: 60,
    },
    remaining: 85,
    cost: 21.0,
    label: 'Shelf B2',
  },
  {
    key: 'teal',
    filament: {
      name: 'PLA Teal',
      brand: 'Sunlu',
      material: 'PLA',
      colorName: 'Teal',
      colorHex: '#2fa6a0',
      nozzleTempC: 210,
      bedTempC: 60,
    },
    remaining: 730,
    cost: 17.5,
    label: 'Shelf B3',
  },
]

interface SeedPrint {
  model: string
  daysAgo: number
  hours: number
  printer: string
  slicer: string
  spool: string
  grams: number
  rating: number
  notes: string
  supports: boolean
  status?: 'partial' | 'failed'
}

const PRINTS: SeedPrint[] = [
  {
    model: 'Home & Garden/Spiral Vase',
    daysAgo: 2,
    hours: 3.4,
    printer: 'Bambu Lab P1S',
    slicer: 'Bambu Studio',
    spool: 'gold',
    grams: 86,
    rating: 5,
    notes: 'Silk gold in vase mode looks great. Slight z-seam, nothing a rotation would not fix.',
    supports: false,
  },
  {
    model: 'Functional/Gridfinity Bin 3x2',
    daysAgo: 3,
    hours: 2.1,
    printer: 'Prusa MK4S',
    slicer: 'PrusaSlicer',
    spool: 'black',
    grams: 61,
    rating: 5,
    notes: 'Fits the drawer grid perfectly.',
    supports: false,
  },
  {
    model: 'Functional/Gridfinity Bin 2x1',
    daysAgo: 3,
    hours: 1.2,
    printer: 'Prusa MK4S',
    slicer: 'PrusaSlicer',
    spool: 'black',
    grams: 28,
    rating: 4,
    notes: 'Made four of these.',
    supports: false,
  },
  {
    model: 'Tabletop/Hill Terrain Tile',
    daysAgo: 6,
    hours: 5.8,
    printer: 'Voron 2.4',
    slicer: 'OrcaSlicer',
    spool: 'sage',
    grams: 142,
    rating: 4,
    notes: 'Printed three tiles for Friday.',
    supports: false,
  },
  {
    model: 'Toys & Gifts/Torus Knot Pendant',
    daysAgo: 8,
    hours: 2.7,
    printer: 'Bambu Lab P1S',
    slicer: 'Bambu Studio',
    spool: 'gold',
    grams: 34,
    rating: 5,
    notes: 'Gift for Sam. Lightly sanded.',
    supports: true,
  },
  {
    model: 'Functional/Spool Holder',
    daysAgo: 9,
    hours: 1.9,
    printer: 'Prusa MK4S',
    slicer: 'PrusaSlicer',
    spool: 'orange',
    grams: 52,
    rating: 4,
    notes: 'PETG base, solid at 40% infill.',
    supports: false,
  },
  {
    model: 'Toys & Gifts/Fidget Gear Set',
    daysAgo: 11,
    hours: 1.4,
    printer: 'Bambu Lab P1S',
    slicer: 'Bambu Studio',
    spool: 'teal',
    grams: 38,
    rating: 3,
    notes: 'Gears bind slightly, increase clearance next time.',
    supports: false,
    status: 'partial',
  },
  {
    model: 'Home & Garden/Low Poly Planter',
    daysAgo: 13,
    hours: 4.6,
    printer: 'Voron 2.4',
    slicer: 'OrcaSlicer',
    spool: 'sage',
    grams: 118,
    rating: 5,
    notes: 'Lovely in sage.',
    supports: false,
  },
  {
    model: 'Tabletop/Ruined Tower',
    daysAgo: 16,
    hours: 3.9,
    printer: 'Prusa MK4S',
    slicer: 'PrusaSlicer',
    spool: 'black',
    grams: 97,
    rating: 4,
    notes: '',
    supports: false,
  },
  {
    model: 'Toys & Gifts/Twisted Tower',
    daysAgo: 18,
    hours: 4.2,
    printer: 'Bambu Lab P1S',
    slicer: 'Bambu Studio',
    spool: 'teal',
    grams: 71,
    rating: 5,
    notes: 'The twist reads really well in teal.',
    supports: false,
  },
  {
    model: 'Home & Garden/Bud Vase',
    daysAgo: 21,
    hours: 2.0,
    printer: 'Bambu Lab P1S',
    slicer: 'Bambu Studio',
    spool: 'white',
    grams: 44,
    rating: 4,
    notes: '',
    supports: false,
  },
  {
    model: 'Functional/Phone Stand',
    daysAgo: 24,
    hours: 0.9,
    printer: 'Prusa MK4S',
    slicer: 'PrusaSlicer',
    spool: 'orange',
    grams: 19,
    rating: 4,
    notes: 'Wedge is a little steep. Fine for video calls.',
    supports: false,
  },
  {
    model: 'Tabletop/Chess Pawn',
    daysAgo: 27,
    hours: 0.8,
    printer: 'Voron 2.4',
    slicer: 'OrcaSlicer',
    spool: 'white',
    grams: 11,
    rating: 2,
    notes: 'Warped off the bed. Added a brim and reprinted.',
    supports: false,
    status: 'failed',
  },
  {
    model: 'Tabletop/Chess Pawn',
    daysAgo: 27,
    hours: 0.9,
    printer: 'Voron 2.4',
    slicer: 'OrcaSlicer',
    spool: 'white',
    grams: 12,
    rating: 4,
    notes: 'Brim fixed it.',
    supports: false,
  },
  {
    model: 'Toys & Gifts/Heart Keychain',
    daysAgo: 33,
    hours: 0.4,
    printer: 'Bambu Lab P1S',
    slicer: 'Bambu Studio',
    spool: 'orange',
    grams: 6,
    rating: 5,
    notes: 'Quick one for a birthday.',
    supports: false,
  },
]

interface SeedRequest {
  title: string
  model?: string
  by: string
  quantity: number
  priority: 'low' | 'normal' | 'high'
  dueInDays?: number
  material?: string
  colorHex?: string
  notes?: string
  status?: 'printing' | 'done'
}

const REQUESTS: SeedRequest[] = [
  {
    title: 'Gridfinity Bin 4x2',
    model: 'Functional/Gridfinity Bin 4x2',
    by: 'Priya',
    quantity: 3,
    priority: 'high',
    dueInDays: 2,
    material: 'PLA',
    colorHex: '#23262f',
    notes: 'For the electronics drawer, matte black please.',
    status: 'printing',
  },
  {
    title: 'Spiral Vase',
    model: 'Home & Garden/Spiral Vase',
    by: 'Sam',
    quantity: 2,
    priority: 'normal',
    dueInDays: 5,
    material: 'PLA',
    colorHex: '#d4a537',
    notes: 'Birthday present, wrap-ready by Saturday.',
  },
  {
    title: 'Hill Terrain Tile',
    model: 'Tabletop/Hill Terrain Tile',
    by: 'Jordan',
    quantity: 6,
    priority: 'normal',
    dueInDays: 9,
    material: 'PLA',
    colorHex: '#8fae8b',
  },
  {
    title: 'Hex Pencil Cup',
    model: 'Home & Garden/Hex Pencil Cup',
    by: 'Priya',
    quantity: 1,
    priority: 'low',
    material: 'PETG',
    colorHex: '#f2701d',
  },
  {
    title: 'Rocket Shelf Ornament',
    model: 'Toys & Gifts/Rocket Shelf Ornament',
    by: 'Alex',
    quantity: 2,
    priority: 'normal',
    dueInDays: 14,
    material: 'PLA+',
    colorHex: '#ece9e1',
  },
  {
    title: 'Cable Clips (12 mm)',
    model: 'Functional/Cable Clips',
    by: 'Jordan',
    quantity: 10,
    priority: 'low',
    status: 'done',
  },
]
