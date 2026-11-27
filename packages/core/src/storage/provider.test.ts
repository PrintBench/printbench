// @contract core/storage-provider
import { describe, expect, it } from 'vitest'
import { detectS3Provider, libraryLocationLabel } from './provider'

describe('detectS3Provider', () => {
  it('treats no endpoint as AWS, which is where the SDK sends it', () => {
    expect(detectS3Provider(null)).toEqual({ id: 'aws', name: 'AWS' })
    expect(detectS3Provider('  ')).toEqual({ id: 'aws', name: 'AWS' })
    expect(detectS3Provider('https://s3.eu-west-2.amazonaws.com').id).toBe('aws')
  })

  it.each([
    ['https://s3.eu-central-003.backblazeb2.com', 'Backblaze B2'],
    ['https://0123abcd.r2.cloudflarestorage.com', 'Cloudflare R2'],
    ['https://s3.eu-central-1.wasabisys.com', 'Wasabi'],
    ['https://ams3.digitaloceanspaces.com', 'DigitalOcean Spaces'],
    ['https://storage.googleapis.com', 'Google Cloud Storage'],
    ['https://nl-ams.scw.cloud', 'Scaleway'],
    ['https://fsn1.your-objectstorage.com', 'Hetzner Object Storage'],
  ])('names %s as %s', (endpoint, name) => {
    expect(detectS3Provider(endpoint).name).toBe(name)
  })

  it('matches whole host labels, so a look-alike domain is not mistaken for a vendor', () => {
    expect(detectS3Provider('https://notbackblazeb2.com').id).toBe('other')
    expect(detectS3Provider('https://wasabisys.com.attacker.example').id).toBe('other')
  })

  it('recognises MinIO by its usual host names', () => {
    expect(detectS3Provider('http://minio:9000')).toEqual({ id: 'minio', name: 'MinIO' })
    expect(detectS3Provider('https://minio-01.home.lan').id).toBe('minio')
  })

  it('shows the host, port included, for a gateway it cannot name', () => {
    expect(detectS3Provider('http://nas.local:9000')).toEqual({
      id: 'other',
      name: 'nas.local:9000',
    })
    expect(detectS3Provider('not a url')).toEqual({ id: 'other', name: 'not a url' })
  })
})

describe('libraryLocationLabel', () => {
  it('names the three kinds of place a library can be', () => {
    expect(libraryLocationLabel({ backend: 'local', kind: 'in_place' })).toBe('Existing folder')
    expect(libraryLocationLabel({ backend: 'local', kind: 'managed' })).toBe(
      'Uploads on this server',
    )
    expect(
      libraryLocationLabel({
        backend: 's3',
        kind: 'in_place',
        s3Endpoint: 'https://s3.eu-central-1.wasabisys.com',
      }),
    ).toBe('S3 at Wasabi')
    expect(libraryLocationLabel({ backend: 's3', kind: 'managed', s3Endpoint: null })).toBe(
      'Uploads to S3 at AWS',
    )
  })

  it('says so when an S3 library has no connection', () => {
    expect(libraryLocationLabel({ backend: 's3', kind: 'in_place', hasS3Connection: false })).toBe(
      'S3, no connection',
    )
  })
})
