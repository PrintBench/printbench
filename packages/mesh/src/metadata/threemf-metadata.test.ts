import { beforeAll, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import sharp from 'sharp'
import {
  MAX_3MF_METADATA_XML_BYTES,
  MAX_3MF_EMBEDDED_IMAGE_BYTES,
  readThreeMfMetadata,
  ThreeMfMetadataError,
} from './threemf-metadata'

let cover: Buffer
beforeAll(async () => {
  cover = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#cc8844' } })
    .png()
    .toBuffer()
})

function pack(parts: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([key, value]) => [
        key,
        typeof value === 'string' ? strToU8(value) : value,
      ]),
    ),
  )
}
const relationshipType = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'
const thumbnailType =
  'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail'

describe('bounded embedded 3MF metadata', () => {
  it('uses OPC main model and cover, with attribute order and namespaces independent of geometry', () => {
    const bytes = pack({
      '_rels/.rels': `<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships">
        <r:Relationship Target="/Models/main.model" Id="m" Type="${relationshipType}"/>
        <r:Relationship Target="/Auxiliaries/.thumbnails/thumbnail_3mf.png" Id="t" Type="${thumbnailType}"/>
      </r:Relationships>`,
      'Models/main.model': `<m:model xmlns:m="urn:3mf"><m:metadata name="Title">Miniature Bread Set #3</m:metadata><m:metadata name="Designer">box</m:metadata><m:metadata name="License">Standard Digital File License</m:metadata><m:metadata name="CreationDate">2026-07-02</m:metadata><m:metadata name="DesignModelId">USc68d620a7d3734</m:metadata><m:metadata name="Description">&amp;lt;p&amp;gt;Decorative bread&amp;lt;/p&amp;gt;&amp;lt;ul&amp;gt;&amp;lt;li&amp;gt;No supports&amp;lt;/li&amp;gt;&amp;lt;/ul&amp;gt;</m:metadata><m:resources><m:object><m:metadata name="Title">Object title is not the model title</m:metadata></m:object></m:resources></m:model>`,
      '3D/3dmodel.model': '<model><metadata name="Title">Wrong main part</metadata></model>',
      'Auxiliaries/.thumbnails/thumbnail_3mf.png': cover,
      // Not XML geometry: proves extraction never reads component parts.
      '3D/Objects/broken.model': 'not XML',
    })
    const metadata = readThreeMfMetadata(bytes)
    expect(metadata.title).toBe('Miniature Bread Set #3')
    expect(metadata.designer).toBe('box')
    expect(metadata.license).toBe('Standard Digital File License')
    expect(metadata.creationDate).toBe('2026-07-02')
    expect(metadata.description).toBe('Decorative bread\n\n- No supports')
    expect(metadata.sourceIdentifiers).toEqual({
      'MakerWorld internal design ID': 'USc68d620a7d3734',
    })
    expect(JSON.stringify(metadata)).not.toContain('makerworld.com')
    expect(Buffer.from(metadata.thumbnails[0]!.data)).toEqual(cover)
  })

  it('resolves model-relative OPC thumbnails within the package', () => {
    const metadata = readThreeMfMetadata(
      pack({
        '_rels/.rels': `<Relationships><Relationship Type="${relationshipType}" Target="/Models/main.model"/></Relationships>`,
        'Models/main.model': '<model><metadata name="Title">Cover model</metadata></model>',
        'Models/_rels/main.model.rels': `<Relationships><Relationship Type="${thumbnailType}" Target="../Images/cover.png"/></Relationships>`,
        'Images/cover.png': cover,
      }),
    )
    expect(metadata.thumbnails[0]?.path).toBe('images/cover.png')
  })

  it('ignores external assets and out-of-package targets without fetching', () => {
    const metadata = readThreeMfMetadata(
      pack({
        '3D/3dmodel.model': '<model><metadata name="Title">Local title</metadata></model>',
        '_rels/.rels': `<Relationships><Relationship TargetMode="External" Type="${thumbnailType}" Target="https://example.test/secret.png"/><Relationship Type="${thumbnailType}" Target="../../outside.png"/><Relationship Type="${thumbnailType}" Target="file:///etc/passwd"/></Relationships>`,
        'Images/unrelated-texture.png': cover,
      }),
    )
    expect(metadata.title).toBe('Local title')
    expect(metadata.thumbnails).toEqual([])
  })

  it('retains text while removing executable HTML from rich descriptions', () => {
    const metadata = readThreeMfMetadata(
      pack({
        '3D/3dmodel.model':
          '<model><metadata name="Description"><![CDATA[<p>A &amp; B</p><script>steal()</script><img src="file:///secret" onerror="steal()"><p>For personal use only</p>]]></metadata></model>',
      }),
    )
    expect(metadata.description).toBe('A & B\n\nFor personal use only')
  })

  it('rejects path traversal, duplicate case-folded parts, malformed XML and entities', () => {
    const cases: Record<string, string | Uint8Array>[] = [
      { '../outside.png': cover, '3D/3dmodel.model': '<model/>' },
      { '3D/3dmodel.model': '<model/>', '3d/3dmodel.model': '<model/>' },
      { '3D/3dmodel.model': '<model><metadata name="Title">broken</model>' },
      {
        '3D/3dmodel.model':
          '<!DOCTYPE model [<!ENTITY steal SYSTEM "file:///etc/passwd">]><model><metadata name="Title">&steal;</metadata></model>',
      },
    ]
    for (const parts of cases)
      expect(() => readThreeMfMetadata(pack(parts))).toThrow(ThreeMfMetadataError)
  })

  it('checks declared XML expansion before inflating a compressed oversized part', () => {
    const large = `<model>${' '.repeat(MAX_3MF_METADATA_XML_BYTES)}</model>`
    const bytes = pack({ '3D/3dmodel.model': large })
    expect(bytes.length).toBeLessThan(100_000)
    expect(() => readThreeMfMetadata(bytes)).toThrow(/expanded-size budget/)
  })

  it('caps actual deflate output even when ZIP falsely claims a tiny expanded size', () => {
    const bytes = pack({
      '3D/3dmodel.model': `<model>${' '.repeat(MAX_3MF_METADATA_XML_BYTES)}</model>`,
    })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = 0; offset < bytes.length - 46; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        view.setUint32(offset + 24, 1, true)
        break
      }
    }
    expect(() => readThreeMfMetadata(bytes)).toThrow(/cannot be expanded within its size budget/)
  })

  it('skips oversized cover bytes while keeping descriptive metadata', () => {
    const oversized = new Uint8Array(MAX_3MF_EMBEDDED_IMAGE_BYTES + 1)
    oversized.set(cover.subarray(0, 8))
    const metadata = readThreeMfMetadata(
      pack({
        '3D/3dmodel.model': '<model><metadata name="Title">Useful metadata</metadata></model>',
        'Auxiliaries/.thumbnails/thumbnail_3mf.png': oversized,
      }),
    )
    expect(metadata.title).toBe('Useful metadata')
    expect(metadata.thumbnails).toEqual([])
  })
})
