'use client'
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { AuthCard, AuthShell } from "@/components/auth/auth-shell"
import { Button } from '@repo/ui/button'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { CheckCircle, Loader2, XCircle } from 'lucide-react'
import { isValidDeviceCode, isValidUserCode } from '@/lib/auth/cli-device-code'

type Stage =
  | 'confirm'
  | 'approving'
  | 'declining'
  | 'approved'
  | 'declined'
  | 'error'

/**
 * The browser half of the CLI device flow (RFC 8628). It approves NOTHING on mount:
 * it shows the `user_code` the terminal printed and waits for an explicit press.
 *
 * That gesture is the whole security boundary. The device code is client-chosen, so a
 * link like /cli/login?device_code=<attacker-uuid> could be sent to any signed-in user;
 * when this page auto-approved on mount, opening it bound the victim's account to the
 * attacker's code and handed the attacker's polling CLI the victim's access token,
 * 90-day refresh token and raw git-provider OAuth token. The user must be able to see
 * WHAT they are approving and choose to approve it.
 */
function CliLoginContent() {
  const searchParams = useSearchParams()
  const deviceCode = searchParams.get('device_code')
  const userCode = searchParams.get('user_code')
  const linkIsWellFormed =
    isValidDeviceCode(deviceCode) && isValidUserCode(userCode)

  const [stage, setStage] = useState<Stage>(
    linkIsWellFormed ? 'confirm' : 'error',
  )
  const [error, setError] = useState(
    linkIsWellFormed
      ? ''
      : 'This link is not a valid CLI login request. Run `alethia login` and open the link it prints.',
  )

  /** Binds this device code to the signed-in account — only ever from the button. */
  async function approveDevice() {
    setStage('approving')
    try {
      const response = await fetch('/api/auth/cli/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ device_code: deviceCode, user_code: userCode }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        setError(errorData.error || 'Failed to approve device.')
        setStage('error')
        return
      }
      setStage('approved')
    } catch {
      setError('Could not reach the control plane. Please try again.')
      setStage('error')
    }
  }

  /**
   * Records the refusal server-side — only ever from the "This isn't me" button.
   *
   * This used to be `setStage('declined')` and nothing else, which made the screen's own
   * copy untrue in the way that matters: the refusal lived in React state, so re-opening
   * the link offered the approval prompt again, and the CLI that is polling never learned
   * it had been refused. A failure here is surfaced rather than swallowed — telling
   * somebody their refusal was recorded when it was not is worse than telling them to
   * close the terminal.
   */
  async function declineDevice() {
    setStage('declining')
    try {
      const response = await fetch('/api/auth/cli/deny', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ device_code: deviceCode, user_code: userCode }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        setError(
          errorData.error ||
            'Could not record the refusal. Close your terminal to be sure nothing is shared.',
        )
        setStage('error')
        return
      }
      setStage('declined')
    } catch {
      setError(
        'Could not reach the control plane to record the refusal. Close your terminal to be sure nothing is shared.',
      )
      setStage('error')
    }
  }

  if (stage === 'confirm' || stage === 'approving' || stage === 'declining') {
    return (
      <div className="flex flex-col gap-6">
        <div className="space-y-2 text-center">
          <p className="text-sm font-medium text-text-primary">
            Confirm the code from your terminal
          </p>
          <p className="text-xs text-text-secondary">
            A device is asking to sign in to your account. Approve it only if this
            code matches the one <code>alethia login</code> printed.
          </p>
        </div>

        <div
          className="border border-border bg-surface-sunken py-4 text-center font-mono text-2xl tracking-[0.3em] text-text-primary"
          aria-label="Device confirmation code"
        >
          {userCode}
        </div>

        <div className="flex flex-col gap-2">
          <Button onClick={approveDevice} disabled={stage !== 'confirm'}>
            {stage === 'approving' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Approving…
              </>
            ) : (
              'Approve'
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={declineDevice}
            disabled={stage !== 'confirm'}
          >
            {stage === 'declining' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Refusing…
              </>
            ) : (
              "This isn't me"
            )}
          </Button>
        </div>

        <p className="text-center text-xs text-text-secondary">
          If you did not start this sign-in, do not approve it.
        </p>
      </div>
    )
  }

  if (stage === 'approved') {
    return (
      <div className="flex flex-col items-center justify-center gap-4">
        <div className="h-12 w-12 rounded-full bg-surface-muted flex items-center justify-center">
          <CheckCircle className="h-6 w-6 text-text-primary" />
        </div>
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-text-primary">
            Authentication successful
          </p>
          <p className="text-xs text-text-secondary">
            You can close this window and return to your terminal.
          </p>
        </div>
      </div>
    )
  }

  if (stage === 'declined') {
    return (
      <div className="flex flex-col items-center justify-center gap-4">
        <div className="h-12 w-12 rounded-full bg-surface-muted flex items-center justify-center">
          <XCircle className="h-6 w-6 text-text-primary" />
        </div>
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-text-primary">
            Sign-in not approved
          </p>
          <p className="text-xs text-text-secondary">
            Nothing was shared, and the refusal has been recorded — the device has
            been told, and this link cannot be approved later. You can close this
            window.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
        <XCircle className="h-6 w-6 text-destructive" />
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-text-primary">
          Authentication failed
        </p>
        <p className="text-xs text-destructive">
          {error}
        </p>
      </div>
    </div>
  )
}

/**
 * What `alethia login` opens in the browser — the CLI's device-approval screen.
 *
 * It drew its own chrome: an unlinked logo at `top-6 left-6`, a `rounded-xl`
 * `bg-card` panel with `border-border/50`, and no footer. It is one of the most
 * marketing-visible auth surfaces there is, so it wears the same shell as the
 * login page now. It stays under `(private)` deliberately — an anonymous visitor
 * should be bounced to `/login?next=…` rather than shown an approval prompt.
 */
export default function CliLoginPage() {
  return (
    <AuthShell>
      <AuthCard>
        <div className="mb-6 text-center">
          <p className="vx-eyebrow">Device authorization</p>
          <h1 className="mt-2 font-grotesk text-[22px] font-semibold tracking-[-0.03em] text-text-primary">
            CLI Authentication
          </h1>
        </div>
        <Suspense fallback={
          <div className="flex flex-col items-center justify-center gap-4">
            <Loader2 className="h-10 w-10 animate-spin text-text-tertiary" />
            <p className="text-xs text-text-tertiary">Loading…</p>
          </div>
        }>
          <CliLoginContent />
        </Suspense>
      </AuthCard>
    </AuthShell>
  )
}
