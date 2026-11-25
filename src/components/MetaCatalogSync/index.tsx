'use client'

import React, { useCallback, useState } from 'react'
import { useDocumentInfo, useForm, useFormFields } from '@payloadcms/ui'
import {
    FieldWrapper, LoadingState, EmptyState, ErrorState, SuccessState, ConnectButton, StyledSelect, readJson } from '../shared'

interface CatalogOption {
    id: string
    name: string
    businessId: string
    businessName: string
}

/**
 * Commerce catalog controls for one site. The Facebook account that connected
 * this site is the only account whose catalogs are listed. Saving a catalogue
 * item also pushes that item; this button sends the whole catalogue.
 */
export const MetaCatalogSyncField: React.FC = () => {
    const { id } = useDocumentInfo()
    const { dispatchFields } = useForm()
    const catalogEnabled = useFormFields(([fields]) => Boolean(fields.catalogEnabled?.value))
    const sourceCollection = useFormFields(([fields]) => fields.catalogSourceCollection?.value)
    const [catalogs, setCatalogs] = useState<CatalogOption[] | null>(null)
    const [selected, setSelected] = useState('')
    const [loading, setLoading] = useState(false)
    const [syncing, setSyncing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)

    const loadCatalogs = useCallback(() => {
        if (!id) return
        setLoading(true)
        setError(null)
        fetch(`/api/meta-catalog/catalogs?configId=${id}`)
            .then(readJson)
            .then((data) => {
                if (data.error) { setError(data.error); return }
                setCatalogs(data.catalogs ?? [])
            })
            .catch(() => setError('Failed to load catalogs from the connected Facebook account'))
            .finally(() => setLoading(false))
    }, [id])

    const useCatalog = () => {
        if (!id || !selected) return
        const catalog = catalogs?.find((item) => item.id === selected)
        if (!catalog) return
        setSyncing(true)
        setError(null)
        fetch('/api/meta-catalog/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configId: id, catalogId: catalog.id, businessId: catalog.businessId }),
        })
            .then(readJson)
            .then((data) => {
                if (data.error) { setError(data.error); return }
                dispatchFields({ type: 'UPDATE', path: 'catalogEnabled', value: true })
                dispatchFields({ type: 'UPDATE', path: 'catalogId', value: catalog.id })
                dispatchFields({ type: 'UPDATE', path: 'businessManagerId', value: catalog.businessId })
                if (!sourceCollection) {
                    dispatchFields({ type: 'UPDATE', path: 'catalogSourceCollection', value: 'catalogue-items' })
                }
                setMessage(`This site will sync commerce products to “${catalog.name}”. Save the document after you set the product link template.`)
            })
            .catch(() => setError('Failed to save the catalog'))
            .finally(() => setSyncing(false))
    }

    const syncNow = () => {
        if (!id) return
        setSyncing(true)
        setError(null)
        setMessage(null)
        fetch('/api/meta-catalog/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configId: id }),
        })
            .then(readJson)
            .then((data) => {
                if (data.error) { setError(data.error); return }
                const problems = Array.isArray(data.errors) && data.errors.length ? ` ${data.errors[0]}` : ''
                setMessage(`Sent ${data.synced} product${data.synced === 1 ? '' : 's'} to Meta. ${data.skipped} skipped (no title, price, or link).${problems}`)
            })
            .catch(() => setError('Product sync failed'))
            .finally(() => setSyncing(false))
    }

    if (!id) {
        return (
            <FieldWrapper path="metaCatalogSyncPanel" label="Sync products">
                <EmptyState message="Save this connection first." />
            </FieldWrapper>
        )
    }

    return (
        <FieldWrapper path="metaCatalogSyncPanel" label="Sync products">
            <p style={{ fontSize: '0.8125rem', lineHeight: 1.45, marginTop: 0 }}>
                Uses the Facebook login that connected this site. Commerce catalogue items are sent to the chosen catalog when they are saved, and when you sync the whole catalogue here.
            </p>
            {error && <ErrorState message={error} />}
            {message && <SuccessState message={message} />}
            {catalogs === null ? (
                <ConnectButton onClick={loadCatalogs} disabled={loading}>
                    {loading ? 'Loading catalogs…' : 'Load catalogs from my Facebook'}
                </ConnectButton>
            ) : catalogs.length === 0 ? (
                <EmptyState message="No product catalogs on this Facebook account. Create one in Meta Commerce Manager, then load again." />
            ) : (
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                        <StyledSelect
                            path="metaCatalogSyncPanel_catalog"
                            value={selected}
                            options={catalogs.map((catalog) => ({
                                label: `${catalog.name} (${catalog.businessName})`,
                                value: catalog.id,
                            }))}
                            placeholder="Select a catalog"
                            onChange={setSelected}
                        />
                    </div>
                    <ConnectButton onClick={useCatalog} disabled={!selected || syncing}>
                        Use this catalog
                    </ConnectButton>
                </div>
            )}
            {catalogEnabled && (
                <div style={{ marginTop: '0.75rem' }}>
                    <ConnectButton onClick={syncNow} disabled={syncing}>
                        {syncing ? 'Syncing…' : 'Sync commerce products now'}
                    </ConnectButton>
                </div>
            )}
        </FieldWrapper>
    )
}
