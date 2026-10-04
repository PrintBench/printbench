'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  setMakerWorldCookie,
  connectMakerWorld,
  verifyMakerWorldConnection,
  cancelMakerWorldConnection,
  testMakerWorldConnection,
} from './makerworld-actions'

type Challenge = { method: 'email' | 'authenticator'; challengeId: string }
type Status = { state: 'connected' | 'saved' } | ({ state: 'verification' } & Challenge)
const connectionLabels = {
  saved: 'Connection saved · not checked yet',
  connected: 'Connected · checked with Bambu',
  expired: 'Sign-in expired · reconnect your account',
  unavailable: 'Connection saved · Bambu could not be checked',
  not_connected: 'Not connected',
}

export function MakerWorldConnectionForm({ initialSaved }: { initialSaved: boolean }) {
  const [saved, setSaved] = useState(initialSaved)
  const [connection, setConnection] = useState<keyof typeof connectionLabels>(
    initialSaved ? 'saved' : 'not_connected',
  )
  const [signingIn, setSigningIn] = useState(!initialSaved)
  const [email, setEmail] = useState('')
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [code, setCode] = useState('')
  const [cookie, setCookie] = useState('')
  const [browser, setBrowser] = useState('chromium')
  const [advanced, setAdvanced] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()

  function run(work: () => Promise<void>) {
    setMessage('')
    setError('')
    startTransition(async () => {
      try {
        await work()
      } catch {
        setError('Could not update your MakerWorld connection. Please try again.')
      }
    })
  }

  function acceptStatus(status: Status) {
    if (status.state === 'verification') {
      setChallenge(status)
      setMessage(
        status.method === 'email'
          ? 'Bambu sent a verification code to your email.'
          : 'Enter the current code from your authenticator app.',
      )
      return
    }
    setChallenge(null)
    setCode('')
    setSaved(true)
    setConnection(status.state)
    setSigningIn(false)
    setAdvanced(false)
    setMessage(
      status.state === 'connected'
        ? 'MakerWorld connected. You can now import a model link.'
        : 'Your connection was saved, but Bambu could not confirm it. Use Check connection before importing.',
    )
  }

  function updateCookie(value: string) {
    run(async () => {
      const result = await setMakerWorldCookie(value)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSaved(result.saved)
      setConnection(result.saved ? 'saved' : 'not_connected')
      setSigningIn(!result.saved)
      setChallenge(null)
      setCode('')
      setCookie('')
      setMessage(
        result.saved
          ? 'Cookie saved. Use Check connection to test it.'
          : 'MakerWorld disconnected.',
      )
    })
  }

  return (
    <section
      id="makerworld"
      aria-labelledby="makerworld-heading"
      className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6"
    >
      <div>
        <h2 id="makerworld-heading" className="text-lg font-semibold">
          MakerWorld
        </h2>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Sign in with your Bambu account to import MakerWorld models and print profiles.
        </p>
      </div>
      <p className="text-sm font-medium" role="status">
        {connectionLabels[connection]}
      </p>
      {saved && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const result = await testMakerWorldConnection()
                if (!result.ok) {
                  setError(result.error)
                  return
                }
                setConnection(result.state)
                if (result.state === 'expired') setSigningIn(true)
                if (result.state === 'not_connected') {
                  setSaved(false)
                  setSigningIn(true)
                }
              })
            }
          >
            Check connection
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setSigningIn(true)
              setError('')
              setMessage('')
            }}
          >
            Reconnect
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => updateCookie('')}>
            Disconnect
          </Button>
        </div>
      )}
      {signingIn && (
        <div className="space-y-3">
          {challenge ? (
            <form
              key="bambu-verification"
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                const submittedCode = code
                setCode('')
                run(async () => {
                  const result = await verifyMakerWorldConnection({
                    challengeId: challenge.challengeId,
                    code: submittedCode,
                  })
                  if (!result.ok) {
                    setError(result.error)
                    if (result.retryChallengeId)
                      setChallenge({ ...challenge, challengeId: result.retryChallengeId })
                    if (result.restart) setChallenge(null)
                    return
                  }
                  acceptStatus(result.status)
                })
              }}
            >
              <p className="text-sm text-[var(--color-ink-muted)]">
                {challenge.method === 'email'
                  ? `Enter the six-digit code Bambu sent to ${email}.`
                  : 'Enter the six-digit code from your authenticator app.'}
              </p>
              <label className="block space-y-1 text-sm">
                <span>
                  {challenge.method === 'email' ? 'Email verification code' : 'Authenticator code'}
                </span>
                <Input
                  autoFocus
                  name="bambu-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  disabled={pending}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={pending || !/^\d{6}$/.test(code)}>
                  {pending ? 'Verifying…' : 'Verify and connect'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const result = await cancelMakerWorldConnection()
                      if (!result.ok) {
                        setError(result.error)
                        return
                      }
                      setChallenge(null)
                      setCode('')
                    })
                  }
                >
                  Start again
                </Button>
              </div>
              <p className="text-xs text-[var(--color-ink-muted)]">
                This sign-in expires after ten minutes. To request another email code, choose Start
                again and sign in once more.
              </p>
            </form>
          ) : (
            <form
              key="bambu-credentials"
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                const form = event.currentTarget
                const password = String(new FormData(form).get('bambu-password') ?? '')
                const passwordInput = form.elements.namedItem('bambu-password') as HTMLInputElement
                passwordInput.value = ''
                run(async () => {
                  const result = await connectMakerWorld({ email, password })
                  if (!result.ok) {
                    setError(result.error)
                    return
                  }
                  acceptStatus(result.status)
                })
              }}
            >
              <label className="block space-y-1 text-sm">
                <span>Bambu account email</span>
                <Input
                  type="email"
                  name="bambu-email"
                  autoComplete="off"
                  maxLength={254}
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={pending}
                />
              </label>
              <label className="block space-y-1 text-sm">
                <span>Bambu account password</span>
                <Input
                  type="password"
                  name="bambu-password"
                  autoComplete="off"
                  maxLength={1024}
                  required
                  disabled={pending}
                  aria-describedby="bambu-sign-in-help"
                />
              </label>
              <p id="bambu-sign-in-help" className="text-xs text-[var(--color-ink-muted)]">
                Your sign-in details are sent to Bambu through your PrintBench server. Your password
                and verification code are never saved; only the resulting account token is stored
                encrypted.
              </p>
              <Button type="submit" disabled={pending}>
                {pending ? 'Signing in…' : 'Connect MakerWorld'}
              </Button>
            </form>
          )}
          <p className="text-xs text-[var(--color-ink-muted)]">
            For Global accounts on makerworld.com. If you use Google or Apple sign-in, or Bambu asks
            for a CAPTCHA, use the advanced cookie method below.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
      {saved && (
        <p className="text-sm">
          <Link href="/upload" className="underline">
            Go to Upload to import a model
          </Link>
        </p>
      )}
      <details
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
        className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-4 text-sm"
      >
        <summary className="cursor-pointer font-medium">Advanced: use a cookie instead</summary>
        <div className="mt-4 space-y-4">
          <details className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-4 text-sm">
            <summary className="cursor-pointer font-medium">How to connect MakerWorld</summary>
            <div className="mt-3 space-y-3">
              <label className="block space-y-1">
                <span>Your browser</span>
                <select
                  value={browser}
                  onChange={(event) => setBrowser(event.target.value)}
                  className="h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
                >
                  <option value="chromium">Chrome or Microsoft Edge</option>
                  <option value="firefox">Firefox</option>
                </select>
              </label>
              <ol className="list-decimal space-y-2 pl-5 text-[var(--color-ink-muted)]">
                <li>
                  <a
                    href="https://makerworld.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Open MakerWorld
                  </a>{' '}
                  in this browser and sign in to your account.
                </li>
                <li>
                  On the MakerWorld page, right-click an empty area and choose{' '}
                  <strong>Inspect</strong>. A developer tools panel will open.
                </li>
                <li>
                  {browser === 'firefox' ? (
                    <>
                      Select the <strong>Storage</strong> tab, then expand <strong>Cookies</strong>{' '}
                      and select <strong>https://makerworld.com</strong>.
                    </>
                  ) : (
                    <>
                      Select the <strong>Application</strong> tab (it may be under the{' '}
                      <strong>»</strong> menu). Under <strong>Storage → Cookies</strong>, select{' '}
                      <strong>https://makerworld.com</strong>.
                    </>
                  )}
                </li>
                <li>
                  Find the row named <strong>token</strong>. Double-click its <strong>Value</strong>{' '}
                  cell and copy the full value.
                </li>
                <li>
                  Return here, paste it into <strong>MakerWorld token cookie</strong> below, and
                  choose <strong>Save cookie</strong>.
                </li>
              </ol>
              <p className="text-[var(--color-ink-muted)]">
                Can’t find token? Check that you’re signed in, refresh MakerWorld, and look again.
                If an import later says your session has expired, repeat these steps to replace the
                saved cookie.
              </p>
              <a
                className="inline-block underline"
                href={
                  browser === 'firefox'
                    ? 'https://firefox-source-docs.mozilla.org/devtools-user/storage_inspector/cookies/'
                    : 'https://developer.chrome.com/docs/devtools/application/cookies/'
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                View the browser’s illustrated cookie guide
              </a>
            </div>
          </details>

          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              updateCookie(cookie)
            }}
          >
            <label className="block space-y-1 text-sm">
              <span>MakerWorld token cookie</span>
              <Input
                type="password"
                placeholder="Paste the value you copied from MakerWorld"
                aria-describedby="makerworld-cookie-help"
                autoComplete="off"
                spellCheck={false}
                value={cookie}
                onChange={(event) => setCookie(event.target.value)}
                disabled={pending}
              />
            </label>
            <p id="makerworld-cookie-help" className="text-xs text-[var(--color-ink-muted)]">
              Accepts the token value or a Cookie header containing token=. Treat it like a
              password. It is saved encrypted only for your PrintBench account and never displayed
              again.
            </p>
            <Button type="submit" variant="secondary" disabled={pending || !cookie.trim()}>
              {pending ? 'Saving…' : 'Save cookie'}
            </Button>
          </form>
        </div>
      </details>
    </section>
  )
}
