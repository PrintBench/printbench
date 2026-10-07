/**
 * Scrubs anything that looks like a credential out of text that is about to be
 * stored or shown: captured log lines and the debug report.
 *
 * Best effort by nature. It exists so that a connection string in a stack
 * trace does not end up pasted into a public GitHub issue, not as a guarantee.
 */

const SECRET_ENV_KEYS = [
  'BETTER_AUTH_SECRET',
  'POSTGRES_PASSWORD',
  'S3_SECRET_ACCESS_KEY',
  'AWS_SECRET_ACCESS_KEY',
]

/** Literal secret values this process knows, longest first. */
function knownSecrets(): string[] {
  const values = SECRET_ENV_KEYS.map((key) => process.env[key] ?? '')
  try {
    const url = process.env.DATABASE_URL
    if (url) values.push(decodeURIComponent(new URL(url).password))
  } catch {
    // An unparseable DATABASE_URL has no password to find.
  }
  // Only long values: a weak password that is also an ordinary word ("printbench")
  // would otherwise be blanked out of every line it appears in. Short ones are
  // still caught where they matter, inside a connection string, by the patterns.
  return values.filter((value) => value.length >= 12).sort((a, b) => b.length - a.length)
}

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):([^\s@/]+)@/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/g
const KEYED_VALUE =
  /((?:pass(?:word|wd)?|secret|token|cookie|authorization|api[_-]?key|access[_-]?key|signature)\w*["']?\s*[:=]\s*["']?)([^\s"',;&)}\]]{3,})/gi

export function redactSecrets(text: string): string {
  let out = text
  for (const secret of knownSecrets()) out = out.split(secret).join('[redacted]')
  return out
    .replace(URL_CREDENTIALS, '$1:[redacted]@')
    .replace(BEARER, '$1 [redacted]')
    .replace(KEYED_VALUE, '$1[redacted]')
}
