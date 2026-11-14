'use client'

import React from 'react'
import { Button, FieldLabel, SelectInput } from '@payloadcms/ui'

export const fieldWrapperStyle: React.CSSProperties = {
    marginBottom: '1.5rem',
}

export const descriptionStyle: React.CSSProperties = {
    fontSize: '0.8125rem',
    color: 'var(--theme-elevation-500, #6b7280)',
    marginTop: '0.25rem',
    lineHeight: 1.4,
}

export const messageBoxStyle = (variant: 'info' | 'warning' | 'error' | 'success'): React.CSSProperties => ({
    padding: '0.75rem 1rem',
    borderRadius: 'var(--style-radius, 0.25rem)',
    border: '1px solid',
    borderColor:
        variant === 'error'
            ? 'var(--theme-error-250, #fecaca)'
            : variant === 'warning'
                ? 'var(--theme-warning-250, #fde68a)'
                : variant === 'success'
                    ? 'var(--theme-success-250, #bbf7d0)'
                    : 'var(--theme-elevation-150, #e5e7eb)',
    backgroundColor:
        variant === 'error'
            ? 'var(--theme-error-100, #fef2f2)'
            : variant === 'warning'
                ? 'var(--theme-warning-100, #fffbeb)'
                : variant === 'success'
                    ? 'var(--theme-success-100, #f0fdf4)'
                    : 'var(--theme-elevation-50, #f9fafb)',
    color:
        variant === 'error'
            ? 'var(--theme-error-700, #b91c1c)'
            : variant === 'warning'
                ? 'var(--theme-warning-700, #b45309)'
                : variant === 'success'
                    ? 'var(--theme-success-700, #15803d)'
                    : 'var(--theme-elevation-500, #6b7280)',
    fontSize: '0.875rem',
    lineHeight: 1.4,
    marginBottom: '0.75rem',
})

export interface SelectOption {
    label: string
    value: string
}

interface FieldWrapperProps {
    path: string
    label?: string
    description?: string
    children: React.ReactNode
}

export const FieldWrapper: React.FC<FieldWrapperProps> = ({ path, label, description, children }) => (
    <div style={fieldWrapperStyle}>
        {label && <FieldLabel label={label} path={path} />}
        {children}
        {description && <div style={descriptionStyle}>{description}</div>}
    </div>
)

export const LoadingState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('info')}>⏳ {message}</div>
)

export const EmptyState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('info')}>{message}</div>
)

export const ErrorState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('error')}>⚠️ {message}</div>
)

export const SuccessState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('success')}>✅ {message}</div>
)

export const ConnectButton: React.FC<{ onClick: () => void; disabled?: boolean; children: React.ReactNode }> = ({ onClick, disabled, children }) => (
    <Button type="button" buttonStyle="primary" size="medium" disabled={disabled} onClick={onClick}>
        {children}
    </Button>
)

interface StyledSelectProps {
    path: string
    value: string
    options: SelectOption[]
    placeholder?: string
    onChange: (value: string) => void
}

export const StyledSelect: React.FC<StyledSelectProps> = ({
    path,
    value,
    options,
    placeholder = 'Select an option',
    onChange,
}) => (
    <SelectInput
        path={path}
        name={path}
        value={value}
        onChange={(option: unknown) => {
            const selected = Array.isArray(option) ? option[0] : option
            onChange((selected as { value?: string } | null)?.value != null ? String((selected as { value: string }).value) : '')
        }}
        options={[{ label: `— ${placeholder} —`, value: '' }, ...options]}
    />
)

export interface MetaAppInfo {
    configured: boolean
    maskedAppId: string | null
    loading: boolean
}

/** Fetches whether the platform-level Meta App (META_APP_ID/META_APP_SECRET) is configured — shared by MetaConnectPanel and ThreadsConnectPanel, both of which gate their Connect button on it. */
export function useMetaAppInfo(): MetaAppInfo {
    const [state, setState] = React.useState<MetaAppInfo>({ configured: false, maskedAppId: null, loading: true })

    React.useEffect(() => {
        fetch('/api/meta-oauth/app-info')
            .then((res) => res.json())
            .then((data) => setState({ configured: Boolean(data.configured), maskedAppId: data.maskedAppId ?? null, loading: false }))
            .catch(() => setState({ configured: false, maskedAppId: null, loading: false }))
    }, [])

    return state
}

/** Read-only readout of the shared platform Meta App — populated automatically, never a field the site owner fills in. */
export const MetaAppInfoBadge: React.FC<{ appInfo: MetaAppInfo }> = ({ appInfo }) => {
    if (appInfo.loading) return null
    if (!appInfo.configured) {
        return <ErrorState message="Meta App not configured on this deployment — the platform owner needs to enter its App ID and secret in Platform Settings (or set META_APP_ID and META_APP_SECRET)." />
    }
    return (
        <div style={{ ...messageBoxStyle('info'), display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Platform Meta App</span>
            <code>{appInfo.maskedAppId}</code>
        </div>
    )
}

/** Label/value readout for connected-account details (Business Manager ID, Page, IG handle, etc.) — structured, not a run-on sentence. */
export const DetailList: React.FC<{ items: Array<{ label: string; value: React.ReactNode }> }> = ({ items }) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: '1rem', rowGap: '0.375rem', fontSize: '0.875rem', margin: '0.5rem 0 0.75rem' }}>
        {items.map((item) => (
            <React.Fragment key={item.label}>
                <span style={{ color: 'var(--theme-elevation-500, #6b7280)' }}>{item.label}</span>
                <span>{item.value}</span>
            </React.Fragment>
        ))}
    </div>
)

export const META_OAUTH_MESSAGE_SOURCE = 'payload-meta-oauth'

/**
 * Opens Meta's login in a popup. The callback page posts the result back here
 * and closes. If the browser blocks the popup, the same tab continues the login.
 */
export function openMetaOAuthPopup(
    url: string,
    onResult: (result: { ok: boolean; error: string | null }) => void,
): void {
    const popup = window.open(url, 'payload-meta-oauth', 'popup=yes,width=520,height=720')
    if (!popup) {
        window.location.assign(url.replace(/([?&])popup=1\b/, '$1popup=0'))
        return
    }

    let settled = false
    const finish = (result: { ok: boolean; error: string | null }) => {
        if (settled) return
        settled = true
        window.removeEventListener('message', onMessage)
        window.clearInterval(timer)
        onResult(result)
    }
    const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return
        const data = event.data as { source?: string; ok?: boolean; error?: string | null } | null
        if (!data || data.source !== META_OAUTH_MESSAGE_SOURCE) return
        finish({ ok: Boolean(data.ok), error: data.error ? String(data.error) : null })
    }
    window.addEventListener('message', onMessage)
    const timer = window.setInterval(() => {
        if (popup.closed) finish({ ok: false, error: null })
    }, 400)
}

/** Reads and clears a query param left by an OAuth redirect callback, without a full reload. */
export function useOAuthRedirectMessage(successParam: string, errorParam: string): { success: boolean; error: string | null } {
    const [state, setState] = React.useState<{ success: boolean; error: string | null }>({ success: false, error: null })

    React.useEffect(() => {
        if (typeof window === 'undefined') return
        const params = new URLSearchParams(window.location.search)
        const success = params.get(successParam) === '1'
        const error = params.get(errorParam)
        if (success || error) {
            setState({ success, error })
            params.delete(successParam)
            params.delete(errorParam)
            const newSearch = params.toString()
            const newUrl = `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}`
            window.history.replaceState({}, '', newUrl)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return state
}
