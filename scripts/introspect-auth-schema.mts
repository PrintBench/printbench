/**
 * Prints the exact table shape better-auth expects for the installed version.
 * The @better-auth/cli lags the library, so this is the authoritative source
 * when reconciling packages/db/src/schema/auth.ts after an upgrade.
 *
 *   npx tsx scripts/introspect-auth-schema.mts
 */
process.env.BETTER_AUTH_SECRET ??= 'introspection-secret-at-least-32-chars'
process.env.DATABASE_URL ??= 'postgres://printbench:printbench@localhost:5433/printbench'

const { getAuthTables } = await import('better-auth/db')
const { auth } = await import('@pb/auth')

const tables = getAuthTables(auth.options)
for (const [key, table] of Object.entries(tables)) {
  console.log(`\n== ${key}  (table: ${table.modelName}) ==`)
  for (const [field, def] of Object.entries(table.fields)) {
    const column = def.fieldName ?? field
    const bits: string[] = [def.type as string, def.required ? 'required' : 'optional']
    if (def.defaultValue !== undefined) bits.push('has-default')
    if (def.references) bits.push(`-> ${def.references.model}.${def.references.field}`)
    if (def.unique) bits.push('unique')
    console.log(`  ${column.padEnd(26)} ${bits.join(' ')}`)
  }
}
