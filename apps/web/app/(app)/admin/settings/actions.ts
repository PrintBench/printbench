'use server'

import { revalidatePath } from 'next/cache'
import {
  PolicyError,
  SettingsValidationError,
  assertCan,
  checkForUpdate,
  getSettings,
  resetSetting,
  updateSettings,
  type Settings,
  type UpdateStatus,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb } from '@pb/db'
import { audit } from '@/lib/audit'

type Result = { ok: true } | { ok: false; error: string }

export async function saveSettings(patch: Partial<Settings>): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'settings:manage',
    )

    await updateSettings(getDb(), patch)
    await audit(user, 'settings.updated', undefined, { changed: Object.keys(patch).join(', ') })

    // Settings shape the shell and the health report, so both are stale now.
    revalidatePath('/', 'layout')
    revalidatePath('/admin/settings')
    return { ok: true }
  } catch (error) {
    if (error instanceof SettingsValidationError) return { ok: false, error: error.message }
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not save the settings.' }
  }
}

/**
 * Reads the release feed now, rather than when the cache next expires.
 *
 * `force` is safe to expose because only an admin reaches it, and the answer
 * is a single unauthenticated GET. The setting is re-read here rather than
 * trusted from the client: an admin who has turned the check off must not have
 * their instance call out because a stale page still had the button.
 */
export async function checkForUpdateNow(): Promise<
  { ok: true; status: UpdateStatus } | { ok: false; error: string }
> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'settings:manage',
    )

    if (!(await getSettings(getDb())).updateChecks)
      return { ok: false, error: 'Update checks are turned off. Save that change first.' }

    const status = await checkForUpdate({ currentVersion: process.env.PB_VERSION, force: true })
    // The shell shows a notice for an available upgrade.
    revalidatePath('/', 'layout')
    return { ok: true, status }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not reach the release feed.' }
  }
}

export async function resetToDefault(key: keyof Settings): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'settings:manage',
    )

    await resetSetting(getDb(), key)
    await audit(user, 'settings.reset', undefined, { setting: key })
    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not reset that setting.' }
  }
}
