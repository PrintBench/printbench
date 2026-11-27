import { hashPassword, verifyPassword } from 'better-auth/crypto'

/**
 * Password encoding, split from the auth instance.
 *
 * The demo reset in the worker writes the shared account's credential row
 * itself, inside the transaction that rebuilds the schema. It needs the exact
 * hash format better-auth verifies against, but must not import the auth
 * instance (a web-tier concern that opens its own pool). This file imports
 * only better-auth's hashing, so it is the one part of @pb/auth the worker may
 * use.
 */
export const hashAccountPassword = hashPassword
export const verifyAccountPassword = verifyPassword
