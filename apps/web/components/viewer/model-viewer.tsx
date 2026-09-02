'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Grid3x3, Loader2, RotateCcw, RulerDimensionLine, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDimensions } from '@/components/model/model-card'
import { cn } from '@/lib/cn'
import type { MeshFormat, MeshLoadResponse } from '@/workers/mesh-loader.worker'

/**
 * Interactive 3D viewer.
 *
 * Three deliberate constraints, all about not wrecking the page:
 *
 *   1. Nothing loads until the viewer is scrolled into view.
 *   2. Nothing loads automatically above a size threshold. A 400 MB mesh will
 *      exhaust the tab's memory, so it takes an explicit click, with the
 *      thumbnail shown meanwhile.
 *   3. Parsing happens in a Web Worker. If it does blow up, it takes the worker
 *      with it rather than the tab.
 */

/** Above this, the user must ask. Chosen to sit well inside a tab's budget. */
export const AUTO_LOAD_LIMIT = 150 * 1024 * 1024

/** The authenticated routes, which is what almost every caller wants. */
function defaultUrlFor(fileId: string, kind: 'raw' | 'thumb'): string {
  return kind === 'thumb' ? `/api/files/${fileId}/thumb` : `/api/files/${fileId}/raw?inline=1`
}

export interface ModelViewerProps {
  fileId: string
  format: MeshFormat
  fileSize: number
  filename: string
  /** Shown before load and as the fallback for a file too large to auto-load. */
  thumbnailFileId?: string | null
  /** From settings. Falls back to the built-in limit when not supplied. */
  maxBytes?: number
  /**
   * Where to fetch bytes and thumbnails from.
   *
   * The share page serves the same files through a token-scoped route, because
   * an anonymous visitor has no session for the normal one to check.
   */
  urlFor?: (fileId: string, kind: 'raw' | 'thumb') => string
  className?: string
}

type Phase = 'idle' | 'loading' | 'ready' | 'error'

export function ModelViewer({
  fileId,
  format,
  fileSize,
  filename,
  thumbnailFileId,
  maxBytes = AUTO_LOAD_LIMIT,
  urlFor = defaultUrlFor,
  className,
}: ModelViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const resetViewRef = useRef<(() => void) | null>(null)

  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [triangles, setTriangles] = useState(0)
  const [dimensions, setDimensions] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [wireframe, setWireframe] = useState(false)
  const [showBounds, setShowBounds] = useState(false)

  const tooLarge = fileSize > maxBytes

  /*
   * Only start work once the viewer is on screen — with a fallback.
   *
   * Lazy loading is an optimisation, not a correctness requirement, so it must
   * never be the reason nothing loads. IntersectionObserver is missing in some
   * environments and silently never fires in others (embedded webviews, pages
   * that are not compositing), and the failure mode is a spinner that stays
   * forever. If no callback has arrived shortly after mount, load anyway.
   */
  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }

    let settled = false
    const reveal = () => {
      if (settled) return
      settled = true
      setVisible(true)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          reveal()
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(element)

    const fallback = setTimeout(() => {
      observer.disconnect()
      reveal()
    }, 1500)

    return () => {
      clearTimeout(fallback)
      observer.disconnect()
    }
  }, [])

  const start = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas || phase === 'loading' || phase === 'ready') return

    setPhase('loading')
    setError(null)
    setProgress(0)

    // three is a large dependency; load it only when a model is actually viewed.
    const THREE = await import('three')
    const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')

    const worker = new Worker(new URL('../../workers/mesh-loader.worker.ts', import.meta.url), {
      type: 'module',
    })

    const finished = new Promise<Extract<MeshLoadResponse, { type: 'loaded' }>>(
      (resolve, reject) => {
        worker.addEventListener('message', (event: MessageEvent<MeshLoadResponse>) => {
          const data = event.data
          if (data.type === 'progress') {
            setProgress(data.total > 0 ? data.loaded / data.total : 0)
          } else if (data.type === 'loaded') {
            resolve(data)
          } else if (data.type === 'error') {
            reject(new Error(data.message))
          }
        })
        worker.addEventListener('error', () => reject(new Error('Failed to read this file')))
      },
    )

    worker.postMessage({
      type: 'load',
      url: urlFor(fileId, 'raw'),
      format,
    })

    let result: Extract<MeshLoadResponse, { type: 'loaded' }>
    try {
      result = await finished
    } catch (loadError) {
      worker.terminate()
      setPhase('error')
      setError(loadError instanceof Error ? loadError.message : 'Could not load this model')
      return
    }
    worker.terminate()

    // ---- Scene -------------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    const scene = new THREE.Scene()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(result.positions, 3))
    // Loaders often supply no normals, and STL's stored ones are frequently
    // wrong; computing them from the winding is both cheaper and more reliable.
    geometry.computeVertexNormals()

    const material = new THREE.MeshStandardMaterial({
      color: 0xc8ccd8,
      roughness: 0.62,
      metalness: 0.06,
      // Print meshes routinely have inconsistent winding. Single-sided
      // rendering punches holes straight through such a model.
      side: THREE.DoubleSide,
      flatShading: false,
    })

    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    const [minX, minY, minZ] = result.bounds.min
    const [maxX, maxY, maxZ] = result.bounds.max
    const centre = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1

    // Recentre on the origin rather than moving the camera: models exported
    // from a build plate can sit hundreds of millimetres away, which wrecks
    // orbit behaviour and depth precision.
    mesh.position.set(-centre.x, -centre.y, -centre.z)

    const group = new THREE.Group()
    group.add(mesh)
    // Prints are authored Z-up; three is Y-up.
    group.rotation.x = -Math.PI / 2
    scene.add(group)

    const grid = new THREE.GridHelper(extent * 3, 24, 0x5b6478, 0x333a4a)
    grid.position.y = -(maxZ - minZ) / 2
    grid.visible = showGrid
    scene.add(grid)

    /*
     * A box the exact size of the mesh's own bounding box, centred at the
     * origin like the mesh already is. Added to `group` rather than `scene`
     * so it picks up the same Z-up rotation as the mesh — otherwise the box
     * and the model it is meant to outline would visibly disagree.
     */
    const bounds = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ)),
      new THREE.LineBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.85 }),
    )
    bounds.visible = showBounds
    group.add(bounds)

    scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a2f3a, 2.1))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(1, 1.4, 1)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.5)
    fill.position.set(-1, -0.5, -0.8)
    scene.add(fill)

    const camera = new THREE.PerspectiveCamera(38, 1, extent / 1000, extent * 100)
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    const frame = () => {
      const distance = extent * 2.1
      camera.position.set(distance * 0.75, distance * 0.62, distance * 0.75)
      camera.lookAt(0, 0, 0)
      controls.target.set(0, 0, 0)
      controls.update()
    }
    frame()
    resetViewRef.current = frame

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      renderer.setSize(rect.width, rect.height, false)
      camera.aspect = rect.width / rect.height
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    let running = true
    const tick = () => {
      if (!running) return
      controls.update()
      renderer.render(scene, camera)
      requestAnimationFrame(tick)
    }
    tick()

    cleanupRef.current = () => {
      running = false
      observer.disconnect()
      controls.dispose()
      geometry.dispose()
      material.dispose()
      bounds.geometry.dispose()
      bounds.material.dispose()
      // Frees the GPU context. Browsers allow only a handful of them, so
      // leaking one per model page visit breaks the viewer after a few.
      renderer.dispose()
    }

    // Kept on the element so the toggles can reach them without re-rendering.
    Object.assign(canvas, { __pmGrid: grid, __pmMaterial: material, __pmBounds: bounds })

    setTriangles(result.triangleCount)
    setDimensions(formatDimensions(maxX - minX, maxY - minY, maxZ - minZ))
    setPhase('ready')
  }, [fileId, format, phase, showGrid, showBounds])

  // Auto-start once visible, unless the file is large enough to need a decision.
  useEffect(() => {
    if (visible && phase === 'idle' && !tooLarge) void start()
  }, [visible, phase, tooLarge, start])

  useEffect(() => () => cleanupRef.current?.(), [])

  useEffect(() => {
    const canvas = canvasRef.current as
      (HTMLCanvasElement & { __pmGrid?: { visible: boolean } }) | null
    if (canvas?.__pmGrid) canvas.__pmGrid.visible = showGrid
  }, [showGrid])

  useEffect(() => {
    const canvas = canvasRef.current as
      (HTMLCanvasElement & { __pmBounds?: { visible: boolean } }) | null
    if (canvas?.__pmBounds) canvas.__pmBounds.visible = showBounds
  }, [showBounds])

  useEffect(() => {
    const canvas = canvasRef.current as
      (HTMLCanvasElement & { __pmMaterial?: { wireframe: boolean } }) | null
    if (canvas?.__pmMaterial) canvas.__pmMaterial.wireframe = wireframe
  }, [wireframe])

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-2)]',
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        className={cn(
          'block size-full',
          phase === 'ready' ? 'cursor-grab active:cursor-grabbing' : 'invisible',
        )}
      />

      {phase !== 'ready' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          {thumbnailFileId && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={urlFor(thumbnailFileId, 'thumb')}
              alt=""
              aria-hidden
              className="absolute inset-0 size-full object-contain p-6 opacity-30"
            />
          )}

          <div className="relative flex flex-col items-center gap-3">
            {phase === 'loading' && (
              <>
                <Loader2 className="size-6 animate-spin text-[var(--color-ink-faint)]" />
                <p className="text-sm text-[var(--color-ink-muted)]">
                  {progress > 0 ? `Loading ${Math.round(progress * 100)}%` : 'Loading model…'}
                </p>
              </>
            )}

            {phase === 'error' && (
              <>
                <TriangleAlert className="size-6 text-[var(--color-warning)]" />
                <p className="max-w-xs text-sm text-[var(--color-ink-muted)]">{error}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setPhase('idle')
                    void start()
                  }}
                >
                  Try again
                </Button>
              </>
            )}

            {phase === 'idle' && tooLarge && (
              <>
                <Box className="size-6 text-[var(--color-ink-faint)]" />
                {/* break-words: the filename leads the sentence and a long one
                    has no break opportunity to wrap on. */}
                <p className="max-w-xs break-words text-sm text-[var(--color-ink-muted)]">
                  {filename} is {formatSize(fileSize)}. Loading a mesh this large can use a lot of
                  memory, so it is not opened automatically.
                </p>
                <Button size="sm" onClick={() => void start()}>
                  Load anyway
                </Button>
              </>
            )}

            {phase === 'idle' && !tooLarge && (
              <Loader2 className="size-6 animate-spin text-[var(--color-ink-faint)]" />
            )}
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <>
          <div className="absolute right-3 top-3 flex gap-1.5">
            <ViewerButton label="Reset view" onClick={() => resetViewRef.current?.()}>
              <RotateCcw />
            </ViewerButton>
            <ViewerButton
              label={showGrid ? 'Hide grid' : 'Show grid'}
              active={showGrid}
              onClick={() => setShowGrid((v) => !v)}
            >
              <Grid3x3 />
            </ViewerButton>
            <ViewerButton
              label={wireframe ? 'Solid' : 'Wireframe'}
              active={wireframe}
              onClick={() => setWireframe((v) => !v)}
            >
              <Box />
            </ViewerButton>
            <ViewerButton
              label={showBounds ? 'Hide dimensions' : 'Show dimensions'}
              active={showBounds}
              onClick={() => setShowBounds((v) => !v)}
            >
              <RulerDimensionLine />
            </ViewerButton>
          </div>

          <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col items-start gap-1">
            <p className="rounded bg-black/40 px-2 py-1 text-[11px] tabular-nums text-white/80 backdrop-blur-sm">
              {new Intl.NumberFormat('en-GB').format(triangles)} triangles
            </p>
            {showBounds && dimensions && (
              <p className="rounded bg-black/40 px-2 py-1 text-[11px] tabular-nums text-white/80 backdrop-blur-sm">
                {dimensions}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ViewerButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex size-8 items-center justify-center rounded-[var(--radius-control)] border backdrop-blur-sm transition-colors [&_svg]:size-3.5',
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]/80 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
      )}
    >
      {children}
    </button>
  )
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
