'use client'

import { useState, useTransition } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { createPasswordResetLink } from './password-reset-actions'

export function PasswordResetButton({
  userId,
  email,
  disabled,
}: {
  userId: string
  email: string
  disabled: boolean
}) {
  const [url, setUrl] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [message, setMessage] = useState('')
  const [pending, startTransition] = useTransition()
  return (
    <Popover
      onOpenChange={() => {
        setUrl('')
        setExpiresAt('')
        setMessage('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Reset password for ${email}`}
          title="Reset password"
        >
          <KeyRound />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3 p-3">
        <p className="text-sm font-medium">Reset password for {email}</p>
        <p className="text-xs text-[var(--color-ink-muted)]">
          Create a private, single-use link valid for one hour. Share it with the account owner. No
          email is sent. Creating a new link replaces their previous one.
        </p>
        {url ? (
          <>
            <Input
              aria-label="Password reset link"
              value={url}
              readOnly
              autoComplete="off"
              onFocus={(event) => event.currentTarget.select()}
            />
            <p className="text-xs text-[var(--color-ink-muted)]">
              Expires {new Date(expiresAt).toLocaleString()}.
            </p>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url)
                  setMessage('Link copied.')
                } catch {
                  setMessage('Select and copy the link above.')
                }
              }}
            >
              Copy link
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              setMessage('')
              startTransition(async () => {
                try {
                  const result = await createPasswordResetLink(userId)
                  if (!result.ok) {
                    setMessage(result.error)
                    return
                  }
                  setUrl(result.url)
                  setExpiresAt(result.expiresAt)
                } catch {
                  setMessage('Could not create a password reset link.')
                }
              })
            }}
          >
            {pending ? 'Creating…' : 'Create reset link'}
          </Button>
        )}
        <p role="status" className="text-xs">
          {message}
        </p>
      </PopoverContent>
    </Popover>
  )
}
