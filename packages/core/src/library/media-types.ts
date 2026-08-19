/**
 * Extension -> category registry.
 *
 * Drives what the scanner indexes, what gets a thumbnail, and how files are
 * grouped in the UI. Kept deliberately narrower than the reference app's ~60
 * formats: a format only earns a place here if we can do something useful with
 * it. CAD kernel formats (STEP, IGES) are stored and downloadable but not
 * previewable — dragging in OpenCASCADE to render them is exactly the
 * complexity this project exists to avoid.
 */

export type FileCategory =
  | 'model'
  | 'image'
  | 'archive'
  | 'document'
  | 'slicer'
  | 'video'
  | 'other'

export interface MediaTypeInfo {
  category: FileCategory
  mediaType: string
  /** We have a parser, so a thumbnail and the 3D viewer are possible. */
  previewable?: boolean
  label?: string
}

/** Meshes we can parse ourselves, in pure TypeScript. */
export const PREVIEWABLE_EXTENSIONS = ['stl', '3mf', 'obj', 'ply'] as const

const TABLE: Record<string, MediaTypeInfo> = {
  // --- meshes we can parse ------------------------------------------------
  stl: { category: 'model', mediaType: 'model/stl', previewable: true, label: 'STL' },
  '3mf': { category: 'model', mediaType: 'model/3mf', previewable: true, label: '3MF' },
  obj: { category: 'model', mediaType: 'model/obj', previewable: true, label: 'OBJ' },
  ply: { category: 'model', mediaType: 'model/ply', previewable: true, label: 'PLY' },

  // --- meshes we catalogue but do not render -------------------------------
  mtl: { category: 'model', mediaType: 'model/mtl', label: 'MTL' },
  amf: { category: 'model', mediaType: 'model/amf', label: 'AMF' },
  gltf: { category: 'model', mediaType: 'model/gltf+json', label: 'glTF' },
  glb: { category: 'model', mediaType: 'model/gltf-binary', label: 'GLB' },
  dae: { category: 'model', mediaType: 'model/vnd.collada+xml', label: 'COLLADA' },
  fbx: { category: 'model', mediaType: 'application/octet-stream', label: 'FBX' },
  '3ds': { category: 'model', mediaType: 'application/x-3ds', label: '3DS' },
  off: { category: 'model', mediaType: 'model/off', label: 'OFF' },
  wrl: { category: 'model', mediaType: 'model/vrml', label: 'VRML' },
  x3d: { category: 'model', mediaType: 'model/x3d+xml', label: 'X3D' },

  // --- CAD: stored and downloadable, never previewed -----------------------
  step: { category: 'model', mediaType: 'model/step', label: 'STEP' },
  stp: { category: 'model', mediaType: 'model/step', label: 'STEP' },
  iges: { category: 'model', mediaType: 'model/iges', label: 'IGES' },
  igs: { category: 'model', mediaType: 'model/iges', label: 'IGES' },
  scad: { category: 'model', mediaType: 'text/x-scad', label: 'OpenSCAD' },
  f3d: { category: 'model', mediaType: 'application/octet-stream', label: 'Fusion 360' },
  fcstd: { category: 'model', mediaType: 'application/octet-stream', label: 'FreeCAD' },
  blend: { category: 'model', mediaType: 'application/x-blender', label: 'Blender' },
  '3dm': { category: 'model', mediaType: 'model/3dm', label: 'Rhino' },
  dxf: { category: 'model', mediaType: 'image/vnd.dxf', label: 'DXF' },

  // --- sliced output -------------------------------------------------------
  gcode: { category: 'slicer', mediaType: 'text/x.gcode', label: 'G-code' },
  bgcode: { category: 'slicer', mediaType: 'application/x.bgcode', label: 'Binary G-code' },
  ctb: { category: 'slicer', mediaType: 'application/octet-stream', label: 'Chitubox' },
  cbddlp: { category: 'slicer', mediaType: 'application/octet-stream', label: 'Chitubox' },
  photon: { category: 'slicer', mediaType: 'application/octet-stream', label: 'Photon' },
  sl1: { category: 'slicer', mediaType: 'application/octet-stream', label: 'Prusa SL1' },
  goo: { category: 'slicer', mediaType: 'application/octet-stream', label: 'Elegoo' },
  lys: { category: 'slicer', mediaType: 'application/octet-stream', label: 'Lychee' },
  lyt: { category: 'slicer', mediaType: 'application/octet-stream', label: 'Lychee' },

  // --- images --------------------------------------------------------------
  png: { category: 'image', mediaType: 'image/png' },
  jpg: { category: 'image', mediaType: 'image/jpeg' },
  jpeg: { category: 'image', mediaType: 'image/jpeg' },
  webp: { category: 'image', mediaType: 'image/webp' },
  gif: { category: 'image', mediaType: 'image/gif' },
  avif: { category: 'image', mediaType: 'image/avif' },
  bmp: { category: 'image', mediaType: 'image/bmp' },
  tif: { category: 'image', mediaType: 'image/tiff' },
  tiff: { category: 'image', mediaType: 'image/tiff' },
  svg: { category: 'image', mediaType: 'image/svg+xml' },

  // --- everything else -----------------------------------------------------
  zip: { category: 'archive', mediaType: 'application/zip' },
  rar: { category: 'archive', mediaType: 'application/vnd.rar' },
  '7z': { category: 'archive', mediaType: 'application/x-7z-compressed' },
  gz: { category: 'archive', mediaType: 'application/gzip' },
  tar: { category: 'archive', mediaType: 'application/x-tar' },

  pdf: { category: 'document', mediaType: 'application/pdf' },
  txt: { category: 'document', mediaType: 'text/plain' },
  md: { category: 'document', mediaType: 'text/markdown' },
  nfo: { category: 'document', mediaType: 'text/plain' },
  url: { category: 'document', mediaType: 'text/uri-list' },
  html: { category: 'document', mediaType: 'text/html' },

  mp4: { category: 'video', mediaType: 'video/mp4' },
  webm: { category: 'video', mediaType: 'video/webm' },
  mov: { category: 'video', mediaType: 'video/quicktime' },
}

const UNKNOWN: MediaTypeInfo = { category: 'other', mediaType: 'application/octet-stream' }

/** Lowercased extension without the dot. Empty string when there is not one. */
export function extensionOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // A leading dot means a dotfile (".gitignore"), not an extension.
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function lookup(filename: string): MediaTypeInfo {
  return TABLE[extensionOf(filename)] ?? UNKNOWN
}

export function categoryOf(filename: string): FileCategory {
  return lookup(filename).category
}

export function isModelFile(filename: string): boolean {
  return lookup(filename).category === 'model'
}

export function isPreviewable(filename: string): boolean {
  return lookup(filename).previewable === true
}

export function isImage(filename: string): boolean {
  return lookup(filename).category === 'image'
}

/**
 * Extensions worth indexing. Anything not listed is ignored by the scanner
 * rather than stored as a mystery row.
 */
export const INDEXABLE_EXTENSIONS: readonly string[] = Object.keys(TABLE)

export function isIndexable(filename: string): boolean {
  return extensionOf(filename) in TABLE
}
