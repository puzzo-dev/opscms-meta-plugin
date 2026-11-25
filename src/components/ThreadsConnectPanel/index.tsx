'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useDocumentInfo } from '@payloadcms/ui'
import {
    FieldWrapper, LoadingState, ErrorState, SuccessState, ConnectButton, useOAuthRedirectMessage,
    useMetaAppInfo, MetaAppInfoBadge, DetailList, readJson } from '../shared'

interface DocSnapshot {
    threadsEnabled?: boolean
    threadsUserId?: string
    threadsUsername?: string
}

/**
 * Custom Field component: "Connect Threads" — its own OAuth flow (separate
 * host/token shape from the Facebook/Instagram connection above, though it
 * reuses the same Meta App ID/Secret — see endpoints/threadsOAuth.ts).
 */
export const ThreadsConnectPanelField: React.FC = () => {
    const { id } = useDocumentInfo()
    const redirectMsg = useOAuthRedirectMessage('threads_oauth_success', 'threads_oauth_error')
    const appInfo = useMetaAppInfo()

    const [doc, setDoc] = useState<DocSnapshot | null>(null)
    const [loadingDoc, setLoadingDoc] = useState(false)

    const loadDoc = useCallback(() => {
        if (!id) return
        setLoadingDoc(true)
        fetch(`/api/meta-config/${id}?depth=0`)
            .then(readJson)
            .then((data) => setDoc(data))
            .catch(() => { /* ignore */ })
            .finally(() => setLoadingDoc(false))
    }, [id])

    useEffect(() => { loadDoc() }, [loadDoc, redirectMsg.success])

    const startConnect = () => {
        if (!id) return
        window.location.href = `/api/threads-oauth/start?configId=${id}`
    }

    if (!id) {
        return (
            <FieldWrapper path="threadsConnectPanel" label="Connect Threads">
                <MetaAppInfoBadge appInfo={appInfo} />
                <p>Save the document first, then Connect Threads will be available.</p>
            </FieldWrapper>
        )
    }

    const isConnected = Boolean(doc?.threadsUserId)

    return (
        <FieldWrapper path="threadsConnectPanel" label="Connect Threads">
            <MetaAppInfoBadge appInfo={appInfo} />
            {redirectMsg.error && <ErrorState message={redirectMsg.error} />}

            {loadingDoc ? (
                <LoadingState message="Loading connection status…" />
            ) : isConnected ? (
                <>
                    <SuccessState message="Connected to Threads" />
                    <DetailList items={[{ label: 'Threads Account', value: `@${doc?.threadsUsername} (${doc?.threadsUserId})` }]} />
                    <ConnectButton onClick={startConnect}>Reconnect / Switch Account</ConnectButton>
                </>
            ) : (
                <ConnectButton onClick={startConnect} disabled={!appInfo.configured}>
                    Connect Threads
                </ConnectButton>
            )}
        </FieldWrapper>
    )
}
