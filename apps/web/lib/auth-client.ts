'use client'

import { createAuthClient } from 'better-auth/react'

/**
 * Browser-side auth client, deliberately minimal.
 *
 * Only session-establishing calls live here. Everything that changes data —
 * including role changes — goes through a server action so the policy check
 * runs on the server. That also keeps the admin client plugin out of the
 * bundle, whose inferred types are not portable across the workspace.
 */
export const authClient = createAuthClient()

export const signIn = authClient.signIn
export const signOut = authClient.signOut
export const useSession = authClient.useSession
