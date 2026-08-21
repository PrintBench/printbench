'use server'

import { revalidatePath } from 'next/cache'
import {
  PolicyError,
  SettingsValidationError,
  assertCan,
  resetSetting,
  updateSettings,
  type Settings,
} from '@pb/core'
import { requireUser } from '@pb/auth'
import { getDb } from '@pb/db'

type Result = { ok: true } | { ok: false; error: string }

export async function saveSettings(patch: Partial<Settings>): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'settings:manage',
    )

    await updateSettings(getDb(), patch)

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

export async function resetToDefault(key: keyof Settings): Promise<Result> {
  try {
    const user = await requireUser()
    assertCan(
      { id: user.id, role: user.role ?? null, banned: user.banned ?? false },
      'settings:manage',
    )

    await resetSetting(getDb(), key)
    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not reset that setting.' }
  }
}
