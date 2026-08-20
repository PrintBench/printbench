import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { readThreeMf } from './threemf'

/**
 * The 3MF production extension.
 *
 * A project file saved by Bambu Studio or Orca puts no geometry in
 * 3dmodel.model at all: that part holds only `<component>` references into
 * `3D/Objects/*.model`, each with its own transform, and the placement lives
 * on the `<build><item>` entries. Reading the root part alone finds no mesh
 * and concludes the file is empty — which is exactly what happened to a real
 * Bambu project: no thumbnail, no dimensions, nothing in the viewer.
 *
 * Every expectation here is a coordinate that can be worked out by hand, so a
 * transposed matrix or a dropped translation fails rather than producing
 * plausible-looking rubbish.
 */

/** A unit tetrahedron at the origin, spanning 0..1 on each axis. */
const TETRA_VERTICES = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const TETRA_FACES = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
]

function meshXml(): string {
  return (
    '<mesh><vertices>' +
    TETRA_VERTICES.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('') +
    '</vertices><triangles>' +
    TETRA_FACES.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('') +
    '</triangles></mesh>'
  )
}

const NS =
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
  'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'

function part(objectsXml: string, buildXml = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS} requiredextensions="p"><resources>${objectsXml}</resources>${buildXml}</model>`
}

/** Packages the parts the way a real production 3MF is laid out. */
function pack(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml':
      strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'),
    '_rels/.rels':
      strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
  }
  for (const [name, xml] of Object.entries(files)) entries[name] = strToU8(xml)
  return zipSync(entries, { mtime: 315_532_800_000 })
}

function read(data: Uint8Array) {
  const triangles: number[][] = []
  const stats = readThreeMf(data, (t) => triangles.push(Array.from(t)))
  return { stats, triangles }
}

describe('3MF production extension', () => {
  it('follows a component into another part', () => {
    const data = pack({
      '3D/Objects/object_1.model': part(`<object id="1" type="model">${meshXml()}</object>`),
      '3D/3dmodel.model': part(
        '<object id="2" type="model"><components>' +
          '<component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>' +
          '</components></object>',
        '<build><item objectid="2"/></build>',
      ),
    })

    const { stats } = read(data)
    expect(stats.triangleCount).toBe(4)
    expect(stats.bbox).toEqual(
      expect.objectContaining({ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }),
    )
  })

  /*
   * The whole point. Without transforms two objects placed apart on the plate
   * both land at the origin and the reported size is far too small.
   */
  it('applies the translation from a build item', () => {
    const data = pack({
      '3D/Objects/object_1.model': part(`<object id="1" type="model">${meshXml()}</object>`),
      '3D/3dmodel.model': part(
        '<object id="2" type="model"><components>' +
          '<component p:path="/3D/Objects/object_1.model" objectid="1"/>' +
          '</components></object>',
        '<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></build>',
      ),
    })

    const { stats } = read(data)
    expect(stats.bbox).toEqual(
      expect.objectContaining({ minX: 10, minY: 20, minZ: 30, maxX: 11, maxY: 21, maxZ: 31 }),
    )
  })

  /*
   * 3MF uses ROW vectors: a point is [x y z 1] * M, so the last three numbers
   * are the translation and the first nine are read across. Transposing the
   * rotation is the classic error and it survives every "does it look right"
   * check until something comes out mirrored.
   */
  it('reads the rotation with the right convention', () => {
    // 90 degrees about Z: x -> y, y -> -x. As 3MF writes it, that is
    // "0 1 0  -1 0 0  0 0 1" followed by no translation.
    const data = pack({
      '3D/Objects/object_1.model': part(`<object id="1" type="model">${meshXml()}</object>`),
      '3D/3dmodel.model': part(
        '<object id="2" type="model"><components>' +
          '<component p:path="/3D/Objects/object_1.model" objectid="1" transform="0 1 0 -1 0 0 0 0 1 0 0 0"/>' +
          '</components></object>',
        '<build><item objectid="2"/></build>',
      ),
    })

    const { stats } = read(data)
    // The tetrahedron spanned 0..1 in x and y; after the rotation it spans
    // -1..0 in x and 0..1 in y. A transposed matrix gives the mirror image.
    expect(stats.bbox!.minX).toBeCloseTo(-1, 5)
    expect(stats.bbox!.maxX).toBeCloseTo(0, 5)
    expect(stats.bbox!.minY).toBeCloseTo(0, 5)
    expect(stats.bbox!.maxY).toBeCloseTo(1, 5)
  })

  it('composes a component transform with the build item transform', () => {
    const data = pack({
      '3D/Objects/object_1.model': part(`<object id="1" type="model">${meshXml()}</object>`),
      '3D/3dmodel.model': part(
        '<object id="2" type="model"><components>' +
          // Component shifts by 5 in x, item shifts by 100 in x.
          '<component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>' +
          '</components></object>',
        '<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></build>',
      ),
    })

    const { stats } = read(data)
    expect(stats.bbox!.minX).toBeCloseTo(105, 5)
    expect(stats.bbox!.maxX).toBeCloseTo(106, 5)
  })

  it('places several objects from several parts', () => {
    const data = pack({
      '3D/Objects/object_1.model': part(`<object id="1" type="model">${meshXml()}</object>`),
      '3D/Objects/object_6.model': part(`<object id="3" type="model">${meshXml()}</object>`),
      '3D/3dmodel.model': part(
        '<object id="2" type="model"><components>' +
          '<component p:path="/3D/Objects/object_1.model" objectid="1"/></components></object>' +
          '<object id="5" type="model"><components>' +
          '<component p:path="/3D/Objects/object_6.model" objectid="3"/></components></object>',
        '<build>' +
          '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>' +
          // The second plate, 252mm along, exactly as a Bambu project does it.
          '<item objectid="5" transform="1 0 0 0 1 0 0 0 1 252 0 0"/>' +
          '</build>',
      ),
    })

    const { stats } = read(data)
    expect(stats.triangleCount).toBe(8)
    expect(stats.bbox!.minX).toBeCloseTo(0, 5)
    expect(stats.bbox!.maxX).toBeCloseTo(253, 5)
  })

  /*
   * Object ids are only unique WITHIN a part. Two parts both numbering their
   * object "1" is normal, and resolving against the wrong one silently draws
   * the wrong shape.
   */
  it('keeps object ids scoped to their own part', () => {
    const small = `<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`
    const large = `<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="50" y="0" z="0"/><vertex x="0" y="50" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`

    const data = pack({
      '3D/Objects/small.model': part(small),
      '3D/Objects/large.model': part(large),
      '3D/3dmodel.model': part(
        '<object id="9" type="model"><components>' +
          '<component p:path="/3D/Objects/large.model" objectid="1"/></components></object>',
        '<build><item objectid="9"/></build>',
      ),
    })

    const { stats } = read(data)
    // Resolving against the wrong part would give a 1mm triangle.
    expect(stats.bbox!.maxX).toBeCloseTo(50, 5)
  })

  it('follows components nested through several parts', () => {
    const data = pack({
      '3D/Objects/leaf.model': part(`<object id="1" type="model">${meshXml()}</object>`),
      '3D/Objects/middle.model': part(
        '<object id="1" type="model"><components>' +
          '<component p:path="/3D/Objects/leaf.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 1 0 0"/>' +
          '</components></object>',
      ),
      '3D/3dmodel.model': part(
        '<object id="1" type="model"><components>' +
          '<component p:path="/3D/Objects/middle.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>' +
          '</components></object>',
        '<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></build>',
      ),
    })

    const { stats } = read(data)
    // 1 + 10 + 100 accumulated down the chain.
    expect(stats.bbox!.minX).toBeCloseTo(111, 5)
  })

  describe('robustness', () => {
    it('ignores a component pointing at a part that is not there', () => {
      const data = pack({
        '3D/Objects/object_1.model': part(`<object id="1" type="model">${meshXml()}</object>`),
        '3D/3dmodel.model': part(
          '<object id="2" type="model"><components>' +
            '<component p:path="/3D/Objects/missing.model" objectid="1"/>' +
            '<component p:path="/3D/Objects/object_1.model" objectid="1"/>' +
            '</components></object>',
          '<build><item objectid="2"/></build>',
        ),
      })

      // The present half still loads rather than the whole file failing.
      expect(read(data).stats.triangleCount).toBe(4)
    })

    it('does not hang on a component cycle', () => {
      const data = pack({
        '3D/Objects/a.model': part(
          '<object id="1" type="model"><components>' +
            '<component p:path="/3D/3dmodel.model" objectid="1"/></components></object>',
        ),
        '3D/3dmodel.model': part(
          '<object id="1" type="model"><components>' +
            '<component p:path="/3D/Objects/a.model" objectid="1"/></components></object>',
          '<build><item objectid="1"/></build>',
        ),
      })

      // No triangles anywhere, so it reports an empty file rather than looping.
      expect(() => read(data)).toThrow(/no triangles/i)
    })

    /*
     * Some exporters write objects with no build section at all. That used to
     * work by emitting every mesh, and must keep working.
     */
    it('falls back to every mesh when there is no build section', () => {
      const data = pack({
        '3D/3dmodel.model': part(`<object id="1" type="model">${meshXml()}</object>`),
      })

      expect(read(data).stats.triangleCount).toBe(4)
    })

    it('tolerates a leading slash or different case in a path', () => {
      const data = pack({
        '3D/Objects/Object_1.model': part(`<object id="1" type="model">${meshXml()}</object>`),
        '3D/3dmodel.model': part(
          '<object id="2" type="model"><components>' +
            '<component p:path="3D/Objects/object_1.model" objectid="1"/>' +
            '</components></object>',
          '<build><item objectid="2"/></build>',
        ),
      })

      expect(read(data).stats.triangleCount).toBe(4)
    })
  })
})
