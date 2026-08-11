'use client'
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { AlethiaLogo } from '@repo/brand/alethia-logo'
import { Button } from '@repo/ui/button'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { CheckCircle, Loader2, XCircle } from 'lucide-react'
import { isValidDeviceCode, isValidUserCode } from '@/lib/auth/cli-device-code'

type Stage = 'confirm' | 'approving' | 'approved' | 'declined' | 'error'

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

  if (stage === 'confirm' || stage === 'approving') {
    return (
      <div className="flex flex-col gap-6">
        <div className="space-y-2 text-center">
          <p className="text-sm font-medium text-foreground">
            Confirm the code from your terminal
          </p>
          <p className="text-xs text-muted-foreground">
            A device is asking to sign in to your account. Approve it only if this
            code matches the one <code>alethia login</code> printed.
          </p>
        </div>

        <div
          className="rounded-lg border border-border/50 bg-muted/40 py-4 text-center font-mono text-2xl tracking-[0.3em] text-foreground"
          aria-label="Device confirmation code"
        >
          {userCode}
        </div>

        <div className="flex flex-col gap-2">
          <Button onClick={approveDevice} disabled={stage === 'approving'}>
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
            onClick={() => setStage('declined')}
            disabled={stage === 'approving'}
          >
            This isn&apos;t me
          </Button>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          If you did not start this sign-in, do not approve it.
        </p>
      </div>
    )
  }

  if (stage === 'approved') {
    return (
      <div className="flex flex-col items-center justify-center gap-4">
        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
          <CheckCircle className="h-6 w-6 text-foreground" />
        </div>
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-foreground">
            Authentication successful
          </p>
          <p className="text-xs text-muted-foreground">
            You can close this window and return to your terminal.
          </p>
        </div>
      </div>
    )
  }

  if (stage === 'declined') {
    return (
      <div className="flex flex-col items-center justify-center gap-4">
        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
          <XCircle className="h-6 w-6 text-foreground" />
        </div>
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-foreground">
            Sign-in not approved
          </p>
          <p className="text-xs text-muted-foreground">
            Nothing was shared. You can close this window.
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
        <p className="text-sm font-medium text-foreground">
          Authentication failed
        </p>
        <p className="text-xs text-destructive">
          {error}
        </p>
      </div>
    </div>
  )
}

export default function CliLoginPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="absolute top-6 left-6">
        <AlethiaLogo withText className="h-6 w-auto text-foreground" />
      </div>

      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-sm border border-border/50 rounded-xl bg-card p-8">
          <div className="text-center mb-6">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              CLI Authentication
            </h1>
          </div>
          <Suspense fallback={
            <div className="flex flex-col items-center justify-center gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Loading…</p>
            </div>
          }>
            <CliLoginContent />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
