import { zipSync } from 'fflate'

/**
 * Deterministic test geometry.
 *
 * Generated rather than checked in as binary blobs, so the expected triangle
 * counts and bounding boxes are derivable from the code rather than trusted.
 * Determinism also lets the rasteriser be golden-image tested.
 */

export interface Mesh {
  /** Flat triangle list: 9 floats per triangle. */
  triangles: Float32Array
  triangleCount: number
}

function build(vertices: number[][]): Mesh {
  const triangles = new Float32Array(vertices.length * 9)
  vertices.forEach((triangle, i) => {
    triangles.set(triangle, i * 9)
  })
  return { triangles, triangleCount: vertices.length }
}

/** Axis-aligned cube. 12 triangles, bbox exactly [0,size] on every axis. */
export function cube(size = 10): Mesh {
  const s = size
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], // bottom
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s], // top
  ]
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], // bottom
    [4, 5, 6, 7], // top
    [0, 1, 5, 4], // front
    [1, 2, 6, 5], // right
    [2, 3, 7, 6], // back
    [3, 0, 4, 7], // left
  ]
  const triangles: number[][] = []
  for (const [a, b, c, d] of quads) {
    triangles.push([...v[a]!, ...v[b]!, ...v[c]!])
    triangles.push([...v[a]!, ...v[c]!, ...v[d]!])
  }
  return build(triangles)
}

/** UV sphere. Poles use triangles, the rest quads, so the count is exact. */
export function sphere(radius = 5, segments = 12, rings = 8): Mesh {
  const point = (ring: number, segment: number): number[] => {
    const phi = (ring / rings) * Math.PI
    const theta = (segment / segments) * Math.PI * 2
    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
    ]
  }

  const triangles: number[][] = []
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = point(ring, segment)
      const b = point(ring + 1, segment)
      const c = point(ring + 1, segment + 1)
      const d = point(ring, segment + 1)
      if (ring !== 0) triangles.push([...a, ...b, ...d])
      if (ring !== rings - 1) triangles.push([...b, ...c, ...d])
    }
  }
  return build(triangles)
}

/** Torus. Every face is a quad, so triangles = 2 x segments x sides. */
export function torus(major = 6, minor = 2, segments = 16, sides = 8): Mesh {
  const point = (i: number, j: number): number[] => {
    const u = (i / segments) * Math.PI * 2
    const v = (j / sides) * Math.PI * 2
    return [
      (major + minor * Math.cos(v)) * Math.cos(u),
      (major + minor * Math.cos(v)) * Math.sin(u),
      minor * Math.sin(v),
    ]
  }

  const triangles: number[][] = []
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = point(i, j)
      const b = point(i + 1, j)
      const c = point(i + 1, j + 1)
      const d = point(i, j + 1)
      triangles.push([...a, ...b, ...c])
      triangles.push([...a, ...c, ...d])
    }
  }
  return build(triangles)
}

/** A flat plate: zero extent on Z. Exercises the degenerate-camera path. */
export function plate(size = 20): Mesh {
  return build([
    [0, 0, 0, size, 0, 0, size, size, 0],
    [0, 0, 0, size, size, 0, 0, size, 0],
  ])
}

/**
 * A mesh full of the rubbish real exporters emit: zero-area slivers, repeated
 * vertices, NaN and Infinity. Nothing here should crash a parser or poison a
 * bounding box.
 */
export function degenerateSoup(): Mesh {
  return build([
    [0, 0, 0, 10, 0, 0, 0, 10, 0], // one good triangle
    [1, 1, 1, 1, 1, 1, 1, 1, 1], // all three vertices identical
    [0, 0, 0, 5, 5, 5, 10, 10, 10], // collinear: zero area
    [0, 0, 0, 1, 0, 0, NaN, 0, 0], // NaN
    [0, 0, 0, 1, 0, 0, Infinity, 0, 0], // Infinity
    [2, 2, 0, 2, 2, 0, 8, 8, 0], // two identical vertices
  ])
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

/** Writes a binary STL. `header` lets tests fake the "solid" trap. */
export function toBinaryStl(mesh: Mesh, header = 'printbench test fixture'): Buffer {
  const buffer = Buffer.alloc(84 + mesh.triangleCount * 50)
  buffer.write(header.slice(0, 79), 0, 'latin1')
  buffer.writeUInt32LE(mesh.triangleCount, 80)

  for (let i = 0; i < mesh.triangleCount; i++) {
    const at = 84 + i * 50
    const t = mesh.triangles.subarray(i * 9, i * 9 + 9)
    // Stored normal left at zero on purpose: real files often have it wrong,
    // and the parser must recompute rather than trust it.
    for (let v = 0; v < 9; v++) buffer.writeFloatLE(t[v]!, at + 12 + v * 4)
  }
  return buffer
}

export function toAsciiStl(mesh: Mesh, name = 'fixture'): Buffer {
  const lines: string[] = [`solid ${name}`]
  for (let i = 0; i < mesh.triangleCount; i++) {
    const t = mesh.triangles.subarray(i * 9, i * 9 + 9)
    lines.push('  facet normal 0 0 0', '    outer loop')
    for (let v = 0; v < 3; v++) {
      lines.push(`      vertex ${t[v * 3]} ${t[v * 3 + 1]} ${t[v * 3 + 2]}`)
    }
    lines.push('    endloop', '  endfacet')
  }
  lines.push(`endsolid ${name}`, '')
  return Buffer.from(lines.join('\n'), 'latin1')
}

export function toObj(mesh: Mesh): Buffer {
  const lines: string[] = ['# printbench test fixture']
  for (let i = 0; i < mesh.triangleCount; i++) {
    const t = mesh.triangles.subarray(i * 9, i * 9 + 9)
    for (let v = 0; v < 3; v++) {
      lines.push(`v ${t[v * 3]} ${t[v * 3 + 1]} ${t[v * 3 + 2]}`)
    }
  }
  for (let i = 0; i < mesh.triangleCount; i++) {
    const base = i * 3 + 1
    lines.push(`f ${base} ${base + 1} ${base + 2}`)
  }
  lines.push('')
  return Buffer.from(lines.join('\n'), 'latin1')
}

export function toAsciiPly(mesh: Mesh): Buffer {
  const vertices: string[] = []
  const faces: string[] = []
  for (let i = 0; i < mesh.triangleCount; i++) {
    const t = mesh.triangles.subarray(i * 9, i * 9 + 9)
    for (let v = 0; v < 3; v++) {
      vertices.push(`${t[v * 3]} ${t[v * 3 + 1]} ${t[v * 3 + 2]}`)
    }
    const base = i * 3
    faces.push(`3 ${base} ${base + 1} ${base + 2}`)
  }

  const header = [
    'ply',
    'format ascii 1.0',
    `element vertex ${vertices.length}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${faces.length}`,
    'property list uchar int vertex_indices',
    'end_header',
  ]
  return Buffer.from([...header, ...vertices, ...faces, ''].join('\n'), 'latin1')
}

/** Binary little-endian PLY, the form most slicers actually export. */
export function toBinaryPly(mesh: Mesh): Buffer {
  const vertexCount = mesh.triangleCount * 3
  const header = Buffer.from(
    [
      'ply',
      'format binary_little_endian 1.0',
      `element vertex ${vertexCount}`,
      'property float x',
      'property float y',
      'property float z',
      `element face ${mesh.triangleCount}`,
      'property list uchar int vertex_indices',
      'end_header',
      '',
    ].join('\n'),
    'latin1',
  )

  const body = Buffer.alloc(vertexCount * 12 + mesh.triangleCount * 13)
  let offset = 0
  for (let i = 0; i < vertexCount; i++) {
    body.writeFloatLE(mesh.triangles[i * 3]!, offset)
    body.writeFloatLE(mesh.triangles[i * 3 + 1]!, offset + 4)
    body.writeFloatLE(mesh.triangles[i * 3 + 2]!, offset + 8)
    offset += 12
  }
  for (let i = 0; i < mesh.triangleCount; i++) {
    body.writeUInt8(3, offset)
    body.writeInt32LE(i * 3, offset + 1)
    body.writeInt32LE(i * 3 + 1, offset + 5)
    body.writeInt32LE(i * 3 + 2, offset + 9)
    offset += 13
  }

  return Buffer.concat([header, body])
}

/** Expected bounding box, computed independently of any parser. */
export function expectedBounds(mesh: Mesh) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < mesh.triangleCount * 3; i++) {
    const x = mesh.triangles[i * 3]!
    const y = mesh.triangles[i * 3 + 1]!
    const z = mesh.triangles[i * 3 + 2]!
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------


export interface ThreeMfOptions {
  unit?: string
  /** Adds a thumbnail part and, unless `withoutRels` is set, a relationship to it. */
  thumbnail?: { path: string; data: Uint8Array }
  /** Extra image parts, to exercise thumbnail selection. */
  extraImages?: Record<string, Uint8Array>
  withoutRels?: boolean
  /** Emits a triangle referencing a vertex that does not exist. */
  corruptIndex?: boolean
}

/** Builds a valid 3MF package around a mesh. */
export function toThreeMf(mesh: Mesh, options: ThreeMfOptions = {}): Uint8Array {
  const unit = options.unit ?? 'millimeter'

  // 3MF is indexed, so deduplicate vertices the way a real writer would.
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  const index = new Map<string, number>()
  const vertices: number[][] = []
  const faces: number[][] = []

  for (let i = 0; i < mesh.triangleCount; i++) {
    const face: number[] = []
    for (let v = 0; v < 3; v++) {
      const x = mesh.triangles[i * 9 + v * 3]!
      const y = mesh.triangles[i * 9 + v * 3 + 1]!
      const z = mesh.triangles[i * 9 + v * 3 + 2]!
      const k = key(x, y, z)
      let id = index.get(k)
      if (id === undefined) {
        id = vertices.length
        vertices.push([x, y, z])
        index.set(k, id)
      }
      face.push(id)
    }
    faces.push(face)
  }

  if (options.corruptIndex) faces.push([0, 1, 999_999])

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
    '  <resources>',
    '    <object id="1" type="model">',
    '      <mesh>',
    '        <vertices>',
    ...vertices.map(([x, y, z]) => `          <vertex x="${x}" y="${y}" z="${z}" />`),
    '        </vertices>',
    '        <triangles>',
    ...faces.map(([a, b, c]) => `          <triangle v1="${a}" v2="${b}" v3="${c}" />`),
    '        </triangles>',
    '      </mesh>',
    '    </object>',
    '  </resources>',
    '  <build><item objectid="1" /></build>',
    '</model>',
  ].join('\n')

  const rels = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model" />',
    options.thumbnail && !options.withoutRels
      ? `  <Relationship Id="rel1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="/${options.thumbnail.path}" />`
      : '',
    '</Relationships>',
  ]
    .filter(Boolean)
    .join('\n')

  const files: Record<string, Uint8Array> = {
    '3D/3dmodel.model': new TextEncoder().encode(xml),
    '_rels/.rels': new TextEncoder().encode(rels),
  }
  if (options.thumbnail) files[options.thumbnail.path] = options.thumbnail.data
  for (const [path, data] of Object.entries(options.extraImages ?? {})) files[path] = data

  return zipSync(files)
}

/** Minimal valid PNG bytes, enough to be recognised as one. */
export function fakePng(marker = 1): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker, 0, 0, 0])
}
