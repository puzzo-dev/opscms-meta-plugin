'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useDocumentInfo, useForm } from '@payloadcms/ui'
import {
    FieldWrapper, LoadingState, EmptyState, ErrorState, SuccessState,
    ConnectButton, StyledSelect, useOAuthRedirectMessage,
    useMetaAppInfo, MetaAppInfoBadge, DetailList, openMetaOAuthPopup,
} from '../shared'
import { clearedMetaUserConnection } from '../../oauth/clearedConnection'

export { MetaTenantDefaults } from './TenantDefaults'

interface DocSnapshot {
    authMethod?: string
    facebookPageId?: string
    facebookPageName?: string
    instagramBusinessAccountId?: string
    instagramUsername?: string
    businessManagerId?: string
    catalogId?: string
    pixelId?: string
    whatsappPhoneNumberId?: string
    whatsappEnabled?: boolean
}

interface PageOption { id: string; name: string }
interface CatalogOption { id: string; name: string; businessId: string; businessName: string }
interface PixelOption { id: string; name: string; businessId: string }
interface NumberOption { id: string; displayPhone: string; verifiedName: string; wabaId: string; wabaName: string }
interface BusinessOption { id: string; name: string }

const stepStyle: React.CSSProperties = { marginTop: '1.25rem' }
const stepTitle: React.CSSProperties = { fontWeight: 600, marginBottom: '0.35rem' }
const hintStyle: React.CSSProperties = { fontSize: '0.8125rem', lineHeight: 1.45, margin: '0 0 0.5rem' }
const rowStyle: React.CSSProperties = { display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }
const nameInputStyle: React.CSSProperties = { width: '100%', padding: '0.5rem 0.6rem' }

/**
 * After Continue with Facebook, this site's login picks a Page, a catalog
 * (or creates one), a Pixel (or creates one), and an official WhatsApp
 * number. Payload notifications use that number. The OpenWA bridge is left
 * in place for sites that do not turn official WhatsApp on.
 */
export const MetaConnectPanelField: React.FC = () => {
    const { id } = useDocumentInfo()
    const { dispatchFields } = useForm()
    const redirectMsg = useOAuthRedirectMessage('meta_oauth_success', 'meta_oauth_error')
    const appInfo = useMetaAppInfo()

    const [doc, setDoc] = useState<DocSnapshot | null>(null)
    const [loadingDoc, setLoadingDoc] = useState(false)
    const [pages, setPages] = useState<PageOption[] | null>(null)
    const [loadingPages, setLoadingPages] = useState(false)
    const [selectedPageId, setSelectedPageId] = useState('')
    const [saving, setSaving] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)
    const [facebookName, setFacebookName] = useState<string | null>(null)

    const [catalogs, setCatalogs] = useState<CatalogOption[] | null>(null)
    const [businesses, setBusinesses] = useState<BusinessOption[]>([])
    const [pixels, setPixels] = useState<PixelOption[] | null>(null)
    const [numbers, setNumbers] = useState<NumberOption[] | null>(null)
    const [assetsError, setAssetsError] = useState<string | null>(null)
    const [selectedCatalogId, setSelectedCatalogId] = useState('')
    const [selectedPixelId, setSelectedPixelId] = useState('')
    const [selectedNumberId, setSelectedNumberId] = useState('')
    const [newCatalogName, setNewCatalogName] = useState('')
    const [newPixelName, setNewPixelName] = useState('')
    const [createBusinessId, setCreateBusinessId] = useState('')
    const [stepMessage, setStepMessage] = useState<string | null>(null)
    const [autoPageFailed, setAutoPageFailed] = useState(false)
    const autoOnce = useRef({ page: false, catalog: false, pixel: false, number: false })

    const loadDoc = useCallback(() => {
        if (!id) return
        setLoadingDoc(true)
        fetch(`/api/meta-config/${id}?depth=0`)
            .then((res) => res.json())
            .then((data) => setDoc(data))
            .catch(() => { /* ignore */ })
            .finally(() => setLoadingDoc(false))
    }, [id])

    const isConnected = doc?.authMethod === 'oauth'
    const hasPage = Boolean(doc?.facebookPageId)

    useEffect(() => { loadDoc() }, [loadDoc, redirectMsg.success])

    useEffect(() => {
        if (!id || !isConnected) return
        fetch(`/api/meta-oauth/me?configId=${id}`)
            .then((res) => res.json())
            .then((data) => { if (data.name) setFacebookName(data.name) })
            .catch(() => { /* the page list still works without the display name */ })
    }, [id, isConnected])

    const loadPages = useCallback(() => {
        if (!id) return
        setLoadingPages(true)
        setActionError(null)
        fetch(`/api/meta-oauth/pages?configId=${id}`)
            .then((res) => res.json())
            .then((data) => {
                if (data.error) { setActionError(data.error); return }
                setPages(data.pages ?? [])
            })
            .catch(() => setActionError('Failed to load Pages'))
            .finally(() => setLoadingPages(false))
    }, [id])

    useEffect(() => {
        if (!id || !isConnected || hasPage || pages !== null || loadingPages) return
        loadPages()
    }, [id, isConnected, hasPage, pages, loadingPages, loadPages])

    const loadAssets = useCallback(() => {
        if (!id) return
        setAssetsError(null)
        Promise.all([
            fetch(`/api/meta-catalog/catalogs?configId=${id}`).then((res) => res.json()),
            fetch(`/api/meta-oauth/pixels?configId=${id}`).then((res) => res.json()),
            fetch(`/api/meta-whatsapp/numbers?configId=${id}`).then((res) => res.json()),
        ]).then(([catalogData, pixelData, numberData]) => {
            if (catalogData.error) setAssetsError(catalogData.error)
            setCatalogs(catalogData.catalogs ?? [])
            setBusinesses(catalogData.businesses ?? pixelData.businesses ?? [])
            setPixels(pixelData.pixels ?? [])
            setNumbers(numberData.numbers ?? [])
            if (!catalogData.error && (pixelData.error || numberData.error)) {
                setAssetsError(pixelData.error || numberData.error)
            }
        }).catch(() => setAssetsError('Could not load catalogs, Pixels, and WhatsApp numbers from this Facebook login.'))
    }, [id])

    useEffect(() => {
        if (!id || !hasPage) return
        loadAssets()
    }, [id, hasPage, doc?.facebookPageId, loadAssets])

    const startConnect = () => {
        if (!id) return
        setActionError(null)
        openMetaOAuthPopup(`/api/meta-oauth/start?configId=${id}&popup=1`, (result) => {
            if (result.error) setActionError(result.error)
            loadDoc()
        })
    }

    const disconnect = () => {
        if (!id) return
        setSaving(true)
        setActionError(null)
        postJson('/api/meta-oauth/disconnect', { configId: id })
            .then((data) => {
                if (data.error) { setActionError(data.error); return }
                const cleared = clearedMetaUserConnection()
                for (const [path, value] of Object.entries(cleared)) {
                    dispatchFields({ type: 'UPDATE', path, value: value ?? '' })
                }
                autoOnce.current = { page: false, catalog: false, pixel: false, number: false }
                setAutoPageFailed(false)
                setPages(null)
                setCatalogs(null)
                setPixels(null)
                setNumbers(null)
                setFacebookName(null)
                setSelectedPageId('')
                setSelectedCatalogId('')
                setSelectedPixelId('')
                setSelectedNumberId('')
                loadDoc()
            })
            .catch(() => setActionError('Failed to disconnect'))
            .finally(() => setSaving(false))
    }

    const postJson = (url: string, body: Record<string, unknown>) =>
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then((res) => res.json())

    const selectPage = (pageId?: string) => {
        const chosen = pageId || selectedPageId
        if (!id || !chosen) return
        setSaving(true)
        setActionError(null)
        postJson('/api/meta-oauth/select-page', { configId: id, pageId: chosen })
            .then((data) => {
                if (data.error) {
                    setActionError(data.error)
                    if (pageId) setAutoPageFailed(true)
                    return
                }
                dispatchFields({ type: 'UPDATE', path: 'facebookPageId', value: data.facebookPageId })
                dispatchFields({ type: 'UPDATE', path: 'facebookPageName', value: data.facebookPageName })
                dispatchFields({ type: 'UPDATE', path: 'instagramBusinessAccountId', value: data.instagramBusinessAccountId || '' })
                dispatchFields({ type: 'UPDATE', path: 'instagramUsername', value: data.instagramUsername || '' })
                dispatchFields({ type: 'UPDATE', path: 'connectionStatus', value: 'connected' })
                dispatchFields({ type: 'UPDATE', path: 'authMethod', value: 'oauth' })
                loadDoc()
                setPages(null)
            })
            .catch(() => setActionError('Failed to select Page'))
            .finally(() => setSaving(false))
    }

    const rememberCatalog = (catalogId: string, businessId?: string) => {
        dispatchFields({ type: 'UPDATE', path: 'catalogEnabled', value: true })
        dispatchFields({ type: 'UPDATE', path: 'catalogId', value: catalogId })
        dispatchFields({ type: 'UPDATE', path: 'catalogSourceCollection', value: 'catalogue-items' })
        if (businessId) dispatchFields({ type: 'UPDATE', path: 'businessManagerId', value: businessId })
    }

    const useCatalog = (catalogId?: string) => {
        const choice = catalogId || selectedCatalogId || doc?.catalogId || ''
        const catalog = catalogs?.find((item) => item.id === choice)
        if (!id || !catalog) return
        setSaving(true)
        setStepMessage(null)
        postJson('/api/meta-catalog/select', { configId: id, catalogId: catalog.id, businessId: catalog.businessId })
            .then((data) => {
                if (data.error) { setAssetsError(data.error); return }
                rememberCatalog(catalog.id, catalog.businessId)
                setStepMessage(`Catalog “${catalog.name}” is the one this site syncs to.`)
                loadDoc()
            })
            .catch(() => setAssetsError('Failed to save the catalog'))
            .finally(() => setSaving(false))
    }

    const createCatalog = () => {
        if (!id || !newCatalogName.trim()) return
        setSaving(true)
        setStepMessage(null)
        postJson('/api/meta-catalog/create', {
            configId: id,
            name: newCatalogName.trim(),
            businessId: createBusinessId || businesses[0]?.id,
        })
            .then((data) => {
                if (data.error) { setAssetsError(data.error); return }
                rememberCatalog(data.catalogId, data.businessId)
                setNewCatalogName('')
                setStepMessage(`Created catalog “${data.name}” and selected it for this site.`)
                loadAssets()
                loadDoc()
            })
            .catch(() => setAssetsError('Failed to create the catalog'))
            .finally(() => setSaving(false))
    }

    const rememberPixel = (pixelId: string, businessId?: string) => {
        dispatchFields({ type: 'UPDATE', path: 'pixelEnabled', value: true })
        dispatchFields({ type: 'UPDATE', path: 'pixelId', value: pixelId })
        if (businessId) dispatchFields({ type: 'UPDATE', path: 'businessManagerId', value: businessId })
    }

    const usePixel = (pixelId?: string) => {
        const choice = pixelId || selectedPixelId || doc?.pixelId || ''
        const pixel = pixels?.find((item) => item.id === choice)
        if (!id || !choice) return
        setSaving(true)
        setStepMessage(null)
        postJson('/api/meta-oauth/select-pixel', { configId: id, pixelId: choice })
            .then((data) => {
                if (data.error) { setAssetsError(data.error); return }
                rememberPixel(data.pixelId, pixel?.businessId)
                setStepMessage(`Pixel “${data.name}” is the one this site uses.`)
                loadDoc()
            })
            .catch(() => setAssetsError('Failed to save the Pixel'))
            .finally(() => setSaving(false))
    }

    const createPixel = () => {
        if (!id || !newPixelName.trim()) return
        setSaving(true)
        setStepMessage(null)
        postJson('/api/meta-oauth/pixels', {
            configId: id,
            name: newPixelName.trim(),
            businessId: createBusinessId || businesses[0]?.id,
        })
            .then((data) => {
                if (data.error) { setAssetsError(data.error); return }
                rememberPixel(data.pixelId, data.businessId)
                setNewPixelName('')
                setStepMessage(`Created Pixel “${newPixelName.trim()}” and selected it for this site.`)
                loadAssets()
                loadDoc()
            })
            .catch(() => setAssetsError('Failed to create the Pixel'))
            .finally(() => setSaving(false))
    }

    const useNumber = (phoneNumberId?: string) => {
        const choice = phoneNumberId || selectedNumberId || doc?.whatsappPhoneNumberId || ''
        if (!id || !choice) return
        setSaving(true)
        setStepMessage(null)
        postJson('/api/meta-whatsapp/select', { configId: id, phoneNumberId: choice })
            .then((data) => {
                if (data.error) { setAssetsError(data.error); return }
                dispatchFields({ type: 'UPDATE', path: 'whatsappEnabled', value: true })
                dispatchFields({ type: 'UPDATE', path: 'whatsappPhoneNumberId', value: data.phoneNumberId })
                dispatchFields({ type: 'UPDATE', path: 'whatsappBusinessAccountId', value: data.wabaId })
                loadDoc()
            })
            .catch(() => setAssetsError('Failed to save the WhatsApp number'))
            .finally(() => setSaving(false))
    }

    useEffect(() => {
        if (autoOnce.current.page || !isConnected || hasPage || !pages || pages.length !== 1) return
        autoOnce.current.page = true
        selectPage(pages[0].id)
    }, [isConnected, hasPage, pages])

    useEffect(() => {
        if (autoOnce.current.catalog || !hasPage || doc?.catalogId || !catalogs || catalogs.length !== 1) return
        autoOnce.current.catalog = true
        useCatalog(catalogs[0].id)
    }, [hasPage, doc?.catalogId, catalogs])

    useEffect(() => {
        if (autoOnce.current.pixel || !hasPage || doc?.pixelId || !pixels || pixels.length !== 1) return
        autoOnce.current.pixel = true
        usePixel(pixels[0].id)
    }, [hasPage, doc?.pixelId, pixels])

    useEffect(() => {
        if (autoOnce.current.number || !hasPage || doc?.whatsappPhoneNumberId || !numbers || numbers.length !== 1) return
        autoOnce.current.number = true
        useNumber(numbers[0].id)
    }, [hasPage, doc?.whatsappPhoneNumberId, numbers])

    if (!id) {
        return (
            <FieldWrapper path="metaConnectPanel" label="Connect to Meta Business">
                <MetaAppInfoBadge appInfo={appInfo} />
                <EmptyState message="Save the document first, then Connect will be available." />
            </FieldWrapper>
        )
    }

    const pagePicker = pages === null ? (
        <ConnectButton onClick={loadPages} disabled={loadingPages}>
            {loadingPages ? 'Loading Pages…' : 'Load My Pages'}
        </ConnectButton>
    ) : pages.length === 0 ? (
        <EmptyState message="No Pages found for this Facebook account. Make sure you admin at least one Facebook Page." />
    ) : (
        <div style={rowStyle}>
            <div style={{ flex: 1 }}>
                <StyledSelect
                    path="metaConnectPanel_pageSelect"
                    value={selectedPageId}
                    options={pages.map((page) => ({ label: page.name, value: page.id }))}
                    placeholder="Select a Page"
                    onChange={setSelectedPageId}
                />
            </div>
            <ConnectButton onClick={() => selectPage()} disabled={!selectedPageId || saving}>
                {saving ? 'Saving…' : 'Use This Page'}
            </ConnectButton>
        </div>
    )

    return (
        <FieldWrapper path="metaConnectPanel" label="Connect to Meta Business">
            <MetaAppInfoBadge appInfo={appInfo} />
            {redirectMsg.error && <ErrorState message={redirectMsg.error} />}
            {redirectMsg.success && !isConnected && <SuccessState message="Connected. Loading the Pages on this Facebook login…" />}
            {actionError && <ErrorState message={actionError} />}

            {loadingDoc ? (
                <LoadingState message="Loading connection status…" />
            ) : !isConnected ? (
                <>
                    <EmptyState message="Log in with the Facebook account that manages this site. The Page, catalog, Pixel, and WhatsApp number fill in from that login. After that they stay read-only." />
                    <ConnectButton onClick={startConnect} disabled={!appInfo.configured}>
                        Log in with Facebook
                    </ConnectButton>
                </>
            ) : (
                <>
                    <SuccessState message={facebookName ? `Signed in as ${facebookName}` : 'Signed in with Facebook'} />
                    {hasPage && (
                        <DetailList
                            items={[
                                { label: 'Facebook login', value: facebookName || '—' },
                                { label: 'Facebook Page', value: `${doc?.facebookPageName} (${doc?.facebookPageId})` },
                                {
                                    label: 'Instagram',
                                    value: doc?.instagramUsername
                                        ? `@${doc.instagramUsername}`
                                        : 'No Instagram Business account linked to this Page',
                                },
                                { label: 'Catalog', value: doc?.catalogId || 'Not chosen yet' },
                                { label: 'Pixel', value: doc?.pixelId || 'Not chosen yet' },
                                { label: 'WhatsApp', value: doc?.whatsappEnabled && doc?.whatsappPhoneNumberId ? doc.whatsappPhoneNumberId : 'Not chosen yet' },
                            ]}
                        />
                    )}
                    {!hasPage && (
                        <div style={stepStyle}>
                            <div style={stepTitle}>1. Facebook Page</div>
                            {pages?.length === 1 && !autoPageFailed ? (
                                <LoadingState message="Saving the Page from this Facebook login…" />
                            ) : (
                                <>
                                    <p style={hintStyle}>Pick the Page this site publishes as. Its Instagram account is detected from that Page. Once saved, it stays read-only.</p>
                                    {pagePicker}
                                </>
                            )}
                        </div>
                    )}

                    {hasPage && (
                        <>
                            {assetsError && <ErrorState message={assetsError} />}
                            {stepMessage && <SuccessState message={stepMessage} />}
                            {catalogs === null ? (
                                <LoadingState message="Loading catalogs, Pixels, and WhatsApp numbers…" />
                            ) : (
                                <>
                                    {!doc?.catalogId && (
                                    <div style={stepStyle}>
                                        <div style={stepTitle}>2. Catalog</div>
                                        <p style={hintStyle}>Commerce catalogue items sync to this catalog. Create one if this Facebook login does not have one yet.</p>
                                        {businesses.length > 1 && (
                                            <div style={{ marginBottom: '0.75rem' }}>
                                                <StyledSelect
                                                    path="metaConnectPanel_business"
                                                    value={createBusinessId || businesses[0]?.id || ''}
                                                    options={businesses.map((business) => ({ label: business.name, value: business.id }))}
                                                    placeholder="Business that will own a new catalog or Pixel"
                                                    onChange={setCreateBusinessId}
                                                />
                                            </div>
                                        )}
                                        {catalogs.length > 0 && (
                                            <div style={{ ...rowStyle, marginBottom: '0.75rem' }}>
                                                <div style={{ flex: 1 }}>
                                                    <StyledSelect
                                                        path="metaConnectPanel_catalog"
                                                        value={selectedCatalogId || doc?.catalogId || ''}
                                                        options={catalogs.map((catalog) => ({
                                                            label: `${catalog.name} (${catalog.businessName})`,
                                                            value: catalog.id,
                                                        }))}
                                                        placeholder="Select a catalog"
                                                        onChange={setSelectedCatalogId}
                                                    />
                                                </div>
                                                <ConnectButton onClick={() => useCatalog()} disabled={!(selectedCatalogId || doc?.catalogId) || saving}>Use this catalog</ConnectButton>
                                            </div>
                                        )}
                                        <div style={rowStyle}>
                                            <input
                                                style={nameInputStyle}
                                                value={newCatalogName}
                                                placeholder="New catalog name"
                                                onChange={(event) => setNewCatalogName(event.target.value)}
                                            />
                                            <ConnectButton onClick={createCatalog} disabled={!newCatalogName.trim() || saving}>
                                                {saving ? 'Saving…' : 'Create catalog'}
                                            </ConnectButton>
                                        </div>
                                    </div>
                                    )}

                                    {!doc?.pixelId && (
                                    <div style={stepStyle}>
                                        <div style={stepTitle}>3. Pixel</div>
                                        <p style={hintStyle}>Used for the Conversions API. Create one if this login does not have a Pixel yet.</p>
                                        {(pixels ?? []).length > 0 && (
                                            <div style={{ ...rowStyle, marginBottom: '0.75rem' }}>
                                                <div style={{ flex: 1 }}>
                                                    <StyledSelect
                                                        path="metaConnectPanel_pixel"
                                                        value={selectedPixelId || doc?.pixelId || ''}
                                                        options={(pixels ?? []).map((pixel) => ({ label: `${pixel.name} (${pixel.id})`, value: pixel.id }))}
                                                        placeholder="Select a Pixel"
                                                        onChange={setSelectedPixelId}
                                                    />
                                                </div>
                                                <ConnectButton onClick={() => usePixel()} disabled={!(selectedPixelId || doc?.pixelId) || saving}>Use this Pixel</ConnectButton>
                                            </div>
                                        )}
                                        <div style={rowStyle}>
                                            <input
                                                style={nameInputStyle}
                                                value={newPixelName}
                                                placeholder="New Pixel name"
                                                onChange={(event) => setNewPixelName(event.target.value)}
                                            />
                                            <ConnectButton onClick={createPixel} disabled={!newPixelName.trim() || saving}>
                                                {saving ? 'Saving…' : 'Create Pixel'}
                                            </ConnectButton>
                                        </div>
                                    </div>
                                    )}

                                    {!doc?.whatsappPhoneNumberId && (
                                    <div style={stepStyle}>
                                        <div style={stepTitle}>4. Official WhatsApp</div>
                                        <p style={hintStyle}>
                                            Choose the number this site sends alerts from. Once saved, it stays read-only.
                                            Leave it unset to keep the existing WhatsApp bridge.
                                        </p>
                                        {numbers === null ? (
                                            <LoadingState message="Looking up WhatsApp numbers." />
                                        ) : numbers.length === 0 ? (
                                            <EmptyState message="No WhatsApp Business numbers on this Facebook login. Disconnect, then log in again, if this account should include WhatsApp." />
                                        ) : (
                                            <div style={rowStyle}>
                                                <div style={{ flex: 1 }}>
                                                    <StyledSelect
                                                        path="metaConnectPanel_whatsapp"
                                                        value={selectedNumberId || doc?.whatsappPhoneNumberId || ''}
                                                        options={(numbers ?? []).map((number) => ({
                                                            label: `${number.displayPhone}${number.verifiedName ? ` · ${number.verifiedName}` : ''} (${number.wabaName})`,
                                                            value: number.id,
                                                        }))}
                                                        placeholder="Select a WhatsApp number"
                                                        onChange={setSelectedNumberId}
                                                    />
                                                </div>
                                                <ConnectButton onClick={() => useNumber()} disabled={!(selectedNumberId || doc?.whatsappPhoneNumberId) || saving}>
                                                    {saving ? 'Saving…' : 'Use for notifications'}
                                                </ConnectButton>
                                            </div>
                                        )}
                                    </div>
                                    )}
                                </>
                            )}
                        </>
                    )}
                    <div style={{ ...stepStyle, display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-start' }}>
                        <p style={hintStyle}>Disconnect removes this site’s Facebook login and the Page, catalog, Pixel, and WhatsApp saved from it. You can log in again afterwards.</p>
                        <ConnectButton onClick={disconnect} disabled={saving}>
                            {saving ? 'Disconnecting…' : 'Disconnect'}
                        </ConnectButton>
                    </div>
                </>
            )}
        </FieldWrapper>
    )
}
