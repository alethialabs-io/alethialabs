'use client'

import { TrellisLogo } from '@/components/trellis-logo'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { CheckCircle, Loader2, XCircle } from 'lucide-react'

function CliLoginContent() {
  const searchParams = useSearchParams()
  const deviceCode = searchParams.get('device_code')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function approveDevice() {
      if (!deviceCode) {
        setError('Device code is missing from the URL.')
        setLoading(false)
        return
      }

      const response = await fetch('/api/auth/cli/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ device_code: deviceCode }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        setError(errorData.error || 'Failed to approve device.')
      }
      setLoading(false)
    }

    approveDevice()
  }, [deviceCode])

  return (
    <>
      {loading && (
        <div className="flex flex-col items-center justify-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
          <div className="text-center space-y-1">
            <p className="text-sm font-medium text-foreground">
              Approving login…
            </p>
            <p className="text-xs text-muted-foreground">
              Connecting your CLI session
            </p>
          </div>
        </div>
      )}
      {!loading && !error && (
        <div className="flex flex-col items-center justify-center gap-4">
          <div className="h-12 w-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
            <CheckCircle className="h-6 w-6 text-emerald-500" />
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
      )}
      {error && (
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
      )}
    </>
  )
}

export default function CliLoginPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="absolute top-6 left-6">
        <TrellisLogo withText className="h-6 w-auto text-foreground" />
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
