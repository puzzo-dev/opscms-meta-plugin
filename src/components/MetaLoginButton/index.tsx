'use client'

import React, { useEffect, useState } from 'react'

/**
 * "Continue with Facebook" under the platform's login form. Shown only when Meta is set up on the server, and says in plain words
 * why a Facebook sign-in did not work (the login page is sent back here with a fixed `fb_error` code).
 */

const MESSAGES: Record<string, string> = {
  denied: 'Facebook sign-in was cancelled.',
  state: 'That sign-in expired or did not start here. Please try again.',
  no_email: 'Facebook did not share an email address, so we cannot tell which account is yours. Sign in with your email and password instead.',
  no_account: 'No account here uses that Facebook email. Accounts are made by invitation: ask your administrator to invite the email you use on Facebook.',
  suspended: 'This account has been suspended. Contact the platform administrator.',
  not_allowed: 'The platform owner account signs in with email and password only.',
  two_factor: 'This account uses two-factor sign-in. Sign in with your email, password and authenticator code instead.',
  conflict: 'This account is already connected to a different Facebook account.',
  not_configured: 'Facebook sign-in is not set up on this server.',
  failed: 'Facebook sign-in could not be completed. Please try again.',
}

export const MetaLoginButton: React.FC = () => {
  const [enabled, setEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('fb_error')
    if (code) setError(MESSAGES[code] ?? MESSAGES.failed)
    let cancelled = false
    fetch('/api/meta-login/status', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { enabled: false }))
      .then((data: { enabled?: boolean }) => {
        if (!cancelled) setEnabled(data.enabled === true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (!enabled && !error) return null
  return (
    <div style={{ marginTop: '1.25rem', display: 'grid', gap: '0.75rem' }}>
      {error && (
        <p role="alert" style={{ margin: 0, padding: '0.6rem 0.8rem', borderLeft: '3px solid var(--theme-error-500, #d33)', background: 'var(--theme-error-100, rgba(221,51,51,0.1))' }}>
          {error}
        </p>
      )}
      {enabled && (
        <a
          href="/api/meta-login/start"
          style={{
            display: 'block',
            textAlign: 'center',
            padding: '0.65rem 1rem',
            borderRadius: 4,
            background: '#1877f2',
            color: '#fff',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Continue with Facebook
        </a>
      )}
    </div>
  )
}

export default MetaLoginButton
