/**
 * Opening a file directly in a desktop slicer.
 *
 * Every modern slicer registers a custom URL scheme, so a link can hand a file
 * straight to it. That covers Bambu Studio, Orca, PrusaSlicer, Cura and Lychee
 * for the price of one feature — and it works for any printer, including ones
 * with no network API at all.
 *
 * It is also the honest answer for Bambu specifically: their printers have no
 * simple HTTP upload, and pushing to them means FTPS plus MQTT with LAN mode
 * enabled. Handing the file to Bambu Studio, which already knows how to talk to
 * them, is both simpler and more reliable.
 *
 * **The file has to be a 3MF.** Bambu Studio's handler contains
 *
 *   if (!extension.Contains(".3mf") && !extension.Contains(".3MF")) {
 *     msg = _L("Download failed, unknown file format."); return; }
 *
 * and it runs that check before downloading, so a link to an STL is refused
 * without a request ever reaching the server. Callers convert on the way out;
 * see serve-as-3mf. The `accepts` lists below describe what each slicer can
 * open once it has the bytes, which is what decides whether to offer the link
 * at all.
 *
 * Expect a "this file is not from a trusted site" prompt too: the handler
 * allowlists makerworld, public-cdn.bblmw.com, amazonaws.com and aliyuncs.com,
 * and a self-hosted instance is none of those. There is nothing to be done
 * about that from this end.
 */

export type SlicerId = 'bambustudio' | 'orcaslicer' | 'prusaslicer' | 'cura' | 'lychee'

export interface Slicer {
  id: SlicerId
  label: string
  /** URL scheme the desktop application registers. */
  scheme: string
  /** Extensions this slicer will accept. */
  accepts: readonly string[]
  /** Shown when the link does nothing, which means the app is not installed. */
  hint: string
}

export const SLICERS: readonly Slicer[] = [
  {
    id: 'bambustudio',
    label: 'Bambu Studio',
    scheme: 'bambustudio://open',
    accepts: ['stl', '3mf', 'obj', 'step', 'stp'],
    hint: 'Bambu Studio 1.7 or later registers this link.',
  },
  {
    id: 'orcaslicer',
    label: 'Orca Slicer',
    scheme: 'orcaslicer://open',
    accepts: ['stl', '3mf', 'obj', 'step', 'stp'],
    hint: 'Orca Slicer 1.8 or later registers this link.',
  },
  {
    id: 'prusaslicer',
    label: 'PrusaSlicer',
    scheme: 'prusaslicer://open',
    accepts: ['stl', '3mf', 'obj', 'step', 'stp', 'amf'],
    hint: 'PrusaSlicer 2.6 or later registers this link.',
  },
  {
    id: 'cura',
    label: 'Cura',
    scheme: 'cura://open',
    accepts: ['stl', '3mf', 'obj', 'amf'],
    hint: 'Cura 5.x registers this link on install.',
  },
  {
    id: 'lychee',
    label: 'Lychee',
    scheme: 'lychee://open',
    accepts: ['stl', '3mf', 'obj'],
    hint: 'Lychee Slicer registers this link on install.',
  },
] as const

export function slicersFor(extension: string): Slicer[] {
  const lower = extension.toLowerCase().replace(/^\./, '')
  return SLICERS.filter((slicer) => slicer.accepts.includes(lower))
}

/**
 * Builds the handoff link.
 *
 * The slicer fetches the URL itself, so it must be absolute and reachable from
 * the desktop — a relative path means nothing outside the browser. It carries
 * its own signature because the slicer is a separate application with no
 * session cookie.
 *
 * `file=` is the parameter every one of these slicers reads.
 */
export function slicerUrl(slicer: Slicer, absoluteFileUrl: string): string {
  return `${slicer.scheme}?file=${encodeURIComponent(absoluteFileUrl)}`
}

/**
 * True when a URL can be handed to a desktop slicer.
 *
 * localhost works only when the slicer runs on the same machine as the browser,
 * which for a self-hosted app on a NAS it usually does not. Callers surface
 * this so the failure is explained rather than silent.
 */
export function isReachableByDesktop(absoluteUrl: string): boolean {
  try {
    const url = new URL(absoluteUrl)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
