'use server'

import { eq, and, ne, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { assertCan, PolicyError, ROLE_ORDER, type Role } from '@pm/core'
import { requireUser } from '@pm/auth'
import { getDb, schema } from '@pm/db'

type Result = { ok: true } | { ok: false; error: string }

export async function setUserRole(userId: string, role: string): Promise<Result> {
  try {
    const actor = await requireUser()
    assertCan({ id: actor.id, role: actor.role ?? null }, 'user:manage')

    if (!ROLE_ORDER.includes(role as Role)) {
      return { ok: false, error: 'Unknown role.' }
    }

    // Changing your own role is how an instance ends up with no admin at all.
    if (userId === actor.id) {
      return { ok: false, error: 'You cannot change your own role.' }
    }

    const db = getDb()

    // Belt and braces: refuse if this would leave zero admins.
    if (role !== 'admin') {
      const remaining = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM "user" WHERE role = 'admin' AND id <> ${userId}
      `)
      if ((remaining.rows[0]?.n ?? 0) === 0) {
        return { ok: false, error: 'There must be at least one admin.' }
      }
    }

    await db
      .update(schema.user)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(schema.user.id, userId), ne(schema.user.id, actor.id)))

    revalidatePath('/admin/users')
    return { ok: true }
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: 'Not permitted.' }
    return { ok: false, error: 'Could not update the role.' }
  }
}
