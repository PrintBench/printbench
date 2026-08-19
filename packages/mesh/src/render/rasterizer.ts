import { boxSize, isEmptyBox, type BoundingBox } from '../types'

/**
 * Software z-buffer rasteriser.
 *
 * This replaces the entire native 3D toolchain the reference application needs
 * (f3d, VTK, OpenCASCADE, mesa-egl) with about four hundred lines and no
 * dependencies. Three properties make that a good trade rather than a
 * reinvention:
 *
 *   1. It streams. A z-buffer needs no mesh in memory — triangles are drawn one
 *      at a time and discarded. A 6 GB STL renders in a fixed ~30 MB. Neither
 *      headless Chromium nor headless-gl can do that; both must hold the whole
 *      mesh, and both hit V8 or GPU limits on exactly the files most worth a
 *      thumbnail.
 *   2. It is deterministic, so the output can be golden-image tested. GPU and
 *      SwiftShader pipelines vary by driver and cannot be.
 *   3. It is identical on Windows and Linux, so what is seen in development is
 *      what ships.
 *
 * Bump RENDERER_VERSION whenever output changes: it is part of the thumbnail
 * cache key, so incrementing it invalidates every cached render.
 */
export const RENDERER_VERSION = 2

export interface RenderOptions {
  /** Output edge length in pixels. */
  size?: number
  /**
   * Supersample factor. Rendering large and downsampling gives clean edges for
   * far less code than any analytic antialiasing, and the cost is linear.
   */
  supersample?: number
  /** Viewing direction, from the object towards the camera. */
  direction?: [number, number, number]
  /** Fraction of the frame left as breathing room. */
  margin?: number
  background?: [number, number, number, number]
  /** Base surface colour, before shading. */
  material?: [number, number, number]
  /** Meshes authored Y-up are rotated so the model stands upright. */
  yUp?: boolean
}

export interface RenderTarget {
  width: number
  height: number
  /** RGBA, supersampled. Caller downsamples and encodes. */
  pixels: Uint8ClampedArray
  /** True once at least one triangle covered a pixel. */
  drawn: boolean
  /**
   * Bounding box of the pixels actually covered.
   *
   * Framing from the model's bounding box alone systematically over-shrinks
   * round shapes: a sphere's box is a cube, and that cube's projected diagonal
   * is about 1.7x the sphere's silhouette, so the sphere ends up small in the
   * frame. Cropping to what was really drawn fixes framing for every shape and
   * costs nothing — the bounds are accumulated while rasterising, so no extra
   * pass over the file is needed.
   */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

const DEFAULTS = {
  size: 512,
  supersample: 3,
  /*
   * Three-quarter view from above. This is the angle slicers use for plate
   * previews, and it reads far better at thumbnail size than a straight-on
   * orthographic view, which flattens depth entirely.
   */
  direction: [1, -1, 0.62] as [number, number, number],
  margin: 0.08,
  background: [0, 0, 0, 0] as [number, number, number, number],
  material: [0.62, 0.66, 0.74] as [number, number, number],
}

/**
 * Camera fitted to a bounding box.
 *
 * Orthographic on purpose: a print is a physical object, and an orthographic
 * view keeps parallel edges parallel, which makes shapes easier to compare
 * across a grid of thumbnails than perspective would.
 */
export class Camera {
  readonly right: [number, number, number]
  readonly up: [number, number, number]
  readonly forward: [number, number, number]
  readonly centre: [number, number, number]
  readonly scale: number
  readonly halfWidth: number
  readonly halfHeight: number

  constructor(box: BoundingBox, width: number, height: number, options: Required<Pick<RenderOptions, 'direction' | 'margin' | 'yUp'>>) {
    const dir = normalize(options.direction)
    // Z-up is the print convention. A Y-up mesh is rotated rather than viewed
    // from a different angle, so lighting stays consistent between the two.
    const worldUp: [number, number, number] = options.yUp ? [0, 1, 0] : [0, 0, 1]

    this.forward = [-dir[0], -dir[1], -dir[2]]
    let right = cross(worldUp, this.forward)
    if (length(right) < 1e-6) {
      // Looking straight down the up axis: any perpendicular will do.
      right = [1, 0, 0]
    }
    this.right = normalize(right)
    this.up = normalize(cross(this.forward, this.right))

    this.centre = [
      (box.minX + box.maxX) / 2,
      (box.minY + box.maxY) / 2,
      (box.minZ + box.maxZ) / 2,
    ]

    // Fit by projecting all eight corners, so the model is framed by what is
    // actually visible rather than by a bounding sphere, which wastes space.
    let extentX = 0
    let extentY = 0
    for (const corner of corners(box)) {
      const dx = corner[0] - this.centre[0]
      const dy = corner[1] - this.centre[1]
      const dz = corner[2] - this.centre[2]
      extentX = Math.max(extentX, Math.abs(dot3(dx, dy, dz, this.right)))
      extentY = Math.max(extentY, Math.abs(dot3(dx, dy, dz, this.up)))
    }

    this.halfWidth = width / 2
    this.halfHeight = height / 2

    const usableX = this.halfWidth * (1 - options.margin)
    const usableY = this.halfHeight * (1 - options.margin)
    // A flat plate has zero extent on one axis; guard against divide-by-zero.
    const scaleX = extentX > 1e-9 ? usableX / extentX : Infinity
    const scaleY = extentY > 1e-9 ? usableY / extentY : Infinity
    const scale = Math.min(scaleX, scaleY)
    this.scale = Number.isFinite(scale) ? scale : 1
  }

  /** World point to screen x, y and depth. Depth increases away from the camera. */
  project(x: number, y: number, z: number, out: Float32Array): void {
    const dx = x - this.centre[0]
    const dy = y - this.centre[1]
    const dz = z - this.centre[2]
    out[0] = this.halfWidth + dot3(dx, dy, dz, this.right) * this.scale
    out[1] = this.halfHeight - dot3(dx, dy, dz, this.up) * this.scale
    out[2] = dot3(dx, dy, dz, this.forward)
  }
}

/**
 * Accumulates triangles into a colour and depth buffer.
 *
 * Created once, fed one triangle at a time, then read. Nothing is retained
 * between triangles, which is what keeps memory flat.
 */
export class Rasterizer {
  private readonly width: number
  private readonly height: number
  private readonly colour: Float32Array
  private readonly depth: Float32Array
  private readonly camera: Camera
  private readonly material: [number, number, number]
  private readonly background: [number, number, number, number]
  private readonly projected = new Float32Array(9)
  private drawn = false
  private boundsMinX = Infinity
  private boundsMinY = Infinity
  private boundsMaxX = -Infinity
  private boundsMaxY = -Infinity

  constructor(box: BoundingBox, options: RenderOptions = {}) {
    const size = options.size ?? DEFAULTS.size
    const supersample = options.supersample ?? DEFAULTS.supersample
    this.width = size * supersample
    this.height = size * supersample

    this.camera = new Camera(box, this.width, this.height, {
      direction: options.direction ?? DEFAULTS.direction,
      margin: options.margin ?? DEFAULTS.margin,
      yUp: options.yUp ?? false,
    })

    this.material = options.material ?? DEFAULTS.material
    this.background = options.background ?? DEFAULTS.background

    this.colour = new Float32Array(this.width * this.height * 4)
    this.depth = new Float32Array(this.width * this.height).fill(Infinity)
  }

  /** Draws one triangle. The array may be reused by the caller afterwards. */
  addTriangle(t: Float32Array): void {
    const p = this.projected
    this.camera.project(t[0]!, t[1]!, t[2]!, p.subarray(0, 3))
    this.camera.project(t[3]!, t[4]!, t[5]!, p.subarray(3, 6))
    this.camera.project(t[6]!, t[7]!, t[8]!, p.subarray(6, 9))

    const x0 = p[0]!, y0 = p[1]!, z0 = p[2]!
    const x1 = p[3]!, y1 = p[4]!, z1 = p[5]!
    const x2 = p[6]!, y2 = p[7]!, z2 = p[8]!

    // Signed area in screen space; zero means the triangle is edge-on.
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (area === 0 || !Number.isFinite(area)) return

    let minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
    let maxX = Math.min(this.width - 1, Math.ceil(Math.max(x0, x1, x2)))
    let minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
    let maxY = Math.min(this.height - 1, Math.ceil(Math.max(y0, y1, y2)))
    if (minX > maxX || minY > maxY) return

    const shade = this.shadeFace(t)
    const inverseArea = 1 / area

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5

        // Barycentric coordinates via edge functions.
        let w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inverseArea
        let w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inverseArea
        let w2 = ((x0 - px) * (y1 - py) - (x1 - px) * (y0 - py)) * inverseArea
        if (w0 < 0 || w1 < 0 || w2 < 0) continue

        const z = w0 * z0 + w1 * z1 + w2 * z2
        const index = y * this.width + x
        if (z >= this.depth[index]!) continue

        this.depth[index] = z
        const at = index * 4
        this.colour[at] = shade[0]!
        this.colour[at + 1] = shade[1]!
        this.colour[at + 2] = shade[2]!
        this.colour[at + 3] = 1
        this.drawn = true

        if (x < this.boundsMinX) this.boundsMinX = x
        if (x > this.boundsMaxX) this.boundsMaxX = x
        if (y < this.boundsMinY) this.boundsMinY = y
        if (y > this.boundsMaxY) this.boundsMaxY = y
      }
    }
  }

  private readonly shadeBuffer = new Float32Array(3)

  /**
   * Flat shading from the face normal.
   *
   * Flat rather than smooth because normals are computed per face from the
   * winding — STL has no vertex normals to interpolate, and the faceting reads
   * as detail at thumbnail size rather than as an artefact.
   *
   * The normal is flipped towards the camera when it faces away, so meshes with
   * inconsistent winding (very common in print files) still shade correctly.
   * Backfaces are drawn rather than culled for the same reason: culling a
   * badly-wound mesh punches holes straight through the model.
   */
  private shadeFace(t: Float32Array): Float32Array {
    const abx = t[3]! - t[0]!, aby = t[4]! - t[1]!, abz = t[5]! - t[2]!
    const acx = t[6]! - t[0]!, acy = t[7]! - t[1]!, acz = t[8]! - t[2]!

    let nx = aby * acz - abz * acy
    let ny = abz * acx - abx * acz
    let nz = abx * acy - aby * acx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len

    const facing = dot3(nx, ny, nz, this.camera.forward)
    if (facing > 0) { nx = -nx; ny = -ny; nz = -nz }

    // Key light offset from the camera, so form reads without flattening.
    const key = normalize([
      this.camera.forward[0] * -1 + this.camera.right[0] * 0.45 + this.camera.up[0] * 0.55,
      this.camera.forward[1] * -1 + this.camera.right[1] * 0.45 + this.camera.up[1] * 0.55,
      this.camera.forward[2] * -1 + this.camera.right[2] * 0.45 + this.camera.up[2] * 0.55,
    ])
    const lambert = Math.max(0, dot3(nx, ny, nz, key))

    /*
     * Hemispheric ambient: cool from below, warmer from above. Kept low so the
     * key light does the work — a high ambient term flattens everything into
     * the same pale grey, which is exactly what makes a thumbnail unreadable
     * at 200 px.
     */
    const upward = (nz + 1) / 2
    const ambientR = 0.13 + 0.10 * upward
    const ambientG = 0.15 + 0.11 * upward
    const ambientB = 0.21 + 0.11 * upward

    // Fill light from the opposite side, so shadowed faces keep some shape
    // instead of going flat black.
    const fill = Math.max(0, -dot3(nx, ny, nz, key)) * 0.16

    // Rim picks the silhouette off the background in both light and dark themes.
    const rim = Math.pow(1 - Math.abs(dot3(nx, ny, nz, this.camera.forward)), 3) * 0.22

    const out = this.shadeBuffer
    out[0] = this.material[0] * (ambientR + lambert * 1.15 + fill) + rim
    out[1] = this.material[1] * (ambientG + lambert * 1.15 + fill) + rim
    out[2] = this.material[2] * (ambientB + lambert * 1.15 + fill) + rim
    return out
  }

  /** Composites onto the background and returns 8-bit RGBA. */
  finish(): RenderTarget {
    const pixels = new Uint8ClampedArray(this.width * this.height * 4)
    const [bgR, bgG, bgB, bgA] = this.background

    for (let i = 0; i < this.width * this.height; i++) {
      const at = i * 4
      const alpha = this.colour[at + 3]!
      if (alpha === 0) {
        pixels[at] = bgR * 255
        pixels[at + 1] = bgG * 255
        pixels[at + 2] = bgB * 255
        pixels[at + 3] = bgA * 255
        continue
      }
      // Linear to sRGB, or everything looks washed out and flat.
      pixels[at] = toSrgb(this.colour[at]!) * 255
      pixels[at + 1] = toSrgb(this.colour[at + 1]!) * 255
      pixels[at + 2] = toSrgb(this.colour[at + 2]!) * 255
      pixels[at + 3] = 255
    }

    return {
      width: this.width,
      height: this.height,
      pixels,
      drawn: this.drawn,
      bounds: {
        minX: this.drawn ? this.boundsMinX : 0,
        minY: this.drawn ? this.boundsMinY : 0,
        maxX: this.drawn ? this.boundsMaxX : this.width - 1,
        maxY: this.drawn ? this.boundsMaxY : this.height - 1,
      },
    }
  }
}

/** True when a box has no volume worth rendering. */
export function isRenderable(box: BoundingBox | null): box is BoundingBox {
  if (!box || isEmptyBox(box)) return false
  const size = boxSize(box)
  // A plate has zero depth but is still renderable; a point is not.
  return size.x + size.y + size.z > 0
}

function toSrgb(linear: number): number {
  const clamped = linear <= 0 ? 0 : linear >= 1 ? 1 : linear
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function length(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2])
}

function dot3(x: number, y: number, z: number, v: [number, number, number]): number {
  return x * v[0] + y * v[1] + z * v[2]
}

function corners(box: BoundingBox): [number, number, number][] {
  return [
    [box.minX, box.minY, box.minZ],
    [box.maxX, box.minY, box.minZ],
    [box.minX, box.maxY, box.minZ],
    [box.maxX, box.maxY, box.minZ],
    [box.minX, box.minY, box.maxZ],
    [box.maxX, box.minY, box.maxZ],
    [box.minX, box.maxY, box.maxZ],
    [box.maxX, box.maxY, box.maxZ],
  ]
}
