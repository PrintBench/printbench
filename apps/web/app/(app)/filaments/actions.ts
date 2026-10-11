'use server'
import { requireUser } from '@pb/auth'
import {
  archiveFilament,
  archiveSpool,
  assertCan,
  createSpool,
  editFilament,
  editSpool,
  measureSpool,
  remainingFromMeasurement,
  type FilamentInput,
  type SpoolInput,
} from '@pb/core'
import { getDb } from '@pb/db'
import { revalidatePath } from 'next/cache'

type Result = { ok: true; id?: string } | { ok: false; error: string }
async function manage(action: (actorId: string) => Promise<string | void>): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(user, 'filament:manage')
    const id = await action(user.id)
    revalidatePath('/filaments', 'layout')
    revalidatePath('/models', 'layout')
    revalidatePath('/prints')
    return { ok: true, ...(id ? { id } : {}) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save the filament.',
    }
  }
}
export async function addSpool(input: SpoolInput): Promise<Result> {
  return manage((actor) => createSpool(getDb(), input, actor))
}
export async function saveSpool(id: string, input: SpoolInput): Promise<Result> {
  return manage(() => editSpool(getDb(), id, input))
}
export async function saveFilament(id: string, input: FilamentInput): Promise<Result> {
  return manage(() => editFilament(getDb(), id, input))
}
export async function setSpoolArchived(id: string, archived: boolean): Promise<Result> {
  return manage(() => archiveSpool(getDb(), id, archived))
}
export async function setFilamentArchived(id: string, archived: boolean): Promise<Result> {
  return manage(() => archiveFilament(getDb(), id, archived))
}
export async function correctSpool(
  id: string,
  input: { remainingG?: number; wholeG?: number; emptyG?: number; reason: string },
): Promise<Result> {
  return manage((actor) => {
    const remaining =
      input.wholeG !== undefined
        ? remainingFromMeasurement(input.wholeG, input.emptyG ?? NaN)
        : (input.remainingG ?? NaN)
    return measureSpool(getDb(), id, remaining, input.reason, actor)
  })
}
