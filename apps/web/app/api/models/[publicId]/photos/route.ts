import { eq } from 'drizzle-orm'
import {
  MAX_PHOTO_UPLOAD_BYTES,
  PhotoValidationError,
  addPhoto,
  assertCan,
  PolicyError,
} from '@pb/core'
import { renderPhoto } from '@pb/mesh'
import { getSessionUser } from '@pb/auth'
import { getDb, schema } from '@pb/db'
import { audit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * Receives one photograph.
 *
 * A route handler rather than a Server Action because an action's request body
 * is capped at a megabyte, and a photograph off a phone is not.
 *
 * It is also the one upload this app does NOT send to the worker. Model files
 * go through tus there because a pack can be gigabytes and must survive a
 * dropped connection; a photo is capped at 25 MB below, decoded once and
 * written twice. Putting it through a resumable protocol and a second process
 * would buy nothing and cost a round trip, a signed token and a pending state
 * the viewer would have to watch.
 *
 * Nothing the browser sent is stored as it arrived: renderPhoto re-encodes to
 * WebP, which is simultaneously the format check, the size bound and the thing
 * that strips the GPS coordinates out of a phone photograph.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  try {
    const user = await getSessionUser()
    if (!user) return json(401, 'Sign in first.')

    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'photo:create',
    )

    const { publicId } = await params
    const rows = await getDb()
      .select({ id: schema.models.id })
      .from(schema.models)
      .where(eq(schema.models.publicId, publicId))
      .limit(1)

    const modelId = rows[0]?.id
    if (!modelId) return json(404, 'That model no longer exists.')

    /*
     * Checked before the body is read, when the browser declares it, and
     * again on the bytes themselves — Content-Length is a claim, not a fact.
     */
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_PHOTO_UPLOAD_BYTES * 1.1) {
      return json(413, 'That image is too large. The limit is 25 MB.')
    }

    const form = await request.formData()
    const file = form.get('photo')
    if (!(file instanceof File)) return json(400, 'No image was sent.')
    if (file.size > MAX_PHOTO_UPLOAD_BYTES) {
      return json(413, 'That image is too large. The limit is 25 MB.')
    }

    const caption = typeof form.get('caption') === 'string' ? String(form.get('caption')) : null
    const printRunId =
      typeof form.get('printRunId') === 'string' && form.get('printRunId') !== ''
        ? String(form.get('printRunId'))
        : null

    const rendered = await renderPhoto(Buffer.from(await file.arrayBuffer()))
    if (!rendered) {
      return json(415, 'That file is not an image this app can read.')
    }

    const id = await addPhoto(getDb(), {
      modelId,
      userId: user.id,
      caption,
      printRunId,
      image: rendered.image,
      thumb: { data: rendered.thumb.data },
    })

    await audit(user, 'photo.added', { type: 'model', id: publicId })

    return Response.json({ ok: true, id }, { status: 201 })
  } catch (error) {
    if (error instanceof PolicyError) return json(403, 'Not permitted.')
    if (error instanceof PhotoValidationError) return json(400, error.message)
    return json(500, 'Could not save that photo.')
  }
}

function json(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status })
}
