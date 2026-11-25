import type { Payload } from 'payload'
import { decryptCredential } from '../utils/metaCrypto'
import { graphPost } from '../utils/metaGraphClient'
import { asCollectionSlug } from '../types'
import {
    catalogSourceSlug,
    deleteRequest,
    relationId,
    toCatalogItem,
    updateRequest,
    type CatalogBatchRequest,
} from './catalogProduct'

export interface CatalogSyncResult {
    synced: number
    skipped: number
    errors: string[]
}

interface CatalogConfig {
    id: string | number
    catalogId: string
    sourceCollection: string
    urlTemplate: string
    token: string
    brand?: string
}

function decryptToken(value: unknown): string {
    if (typeof value !== 'string' || !value || value.includes('•')) return ''
    return value.startsWith('enc:') ? decryptCredential(value) : value
}

/**
 * Catalog writes use the Facebook login token (catalog_management), not the
 * Page token stored for pixel calls. The Page token is the fallback when a
 * site was connected by pasting a token instead of signing in.
 */
export function tokenForCatalog(config: Record<string, unknown>): string {
    return decryptToken(config.oauthUserAccessToken) || decryptToken(config.accessToken)
}

export async function findCatalogConfig(
    payload: Payload,
    siteId: string | number,
): Promise<CatalogConfig | null> {
    const configs = await payload.find({
        collection: asCollectionSlug('meta-config'),
        where: {
            and: [
                { site: { equals: siteId } },
                { isActive: { equals: true } },
                { catalogEnabled: { equals: true } },
            ],
        },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true },
    })
    const config = configs.docs[0] as Record<string, unknown> | undefined
    if (!config) return null
    const catalogId = typeof config.catalogId === 'string' ? config.catalogId.trim() : ''
    const urlTemplate = typeof config.catalogItemUrlTemplate === 'string' ? config.catalogItemUrlTemplate.trim() : ''
    const token = tokenForCatalog(config)
    if (!catalogId || !urlTemplate || !token) return null
    return {
        id: config.id as string | number,
        catalogId,
        sourceCollection: catalogSourceSlug(config.catalogSourceCollection),
        urlTemplate,
        token,
        brand: typeof config.facebookPageName === 'string' ? config.facebookPageName : undefined,
    }
}

async function pushBatch(
    catalogId: string,
    token: string,
    requests: CatalogBatchRequest[],
): Promise<string | null> {
    const result = await graphPost<{ validation_status?: Array<{ errors?: Array<{ message?: string }> }> }>(
        `/${catalogId}/items_batch`,
        {
            access_token: token,
            item_type: 'PRODUCT',
            allow_upsert: 'true',
            requests: JSON.stringify(requests),
        },
    )
    if (!result.ok) return result.error || 'Meta catalog update failed'
    const messages = (result.data?.validation_status ?? [])
        .flatMap((row) => row.errors ?? [])
        .map((error) => error.message)
        .filter((message): message is string => Boolean(message))
    return messages.length ? messages.join('; ') : null
}

/**
 * A save hands the sync the item as it was saved, where its category is only an id. A template with `{category.slug}` needs the category as a document, so it is read here
 * (the full sync reads items one level deep and has it already).
 */
export async function withCategoryRead(payload: Payload, doc: Record<string, unknown>, template: string): Promise<Record<string, unknown>> {
    if (!template.includes('{category.slug}')) return doc
    const category = doc.category
    if (category == null || typeof category === 'object') return doc
    try {
        const read = await payload.findByID({ collection: asCollectionSlug('catalogue-categories'), id: category as string | number, depth: 0, overrideAccess: true })
        return { ...doc, category: read }
    } catch {
        return doc
    }
}

export async function syncCatalogDoc(
    payload: Payload,
    doc: Record<string, unknown>,
    method: 'UPDATE' | 'DELETE',
    collectionSlug: string,
): Promise<void> {
    const siteId = relationId(doc.site)
    if (siteId == null || doc.id == null) return
    const config = await findCatalogConfig(payload, siteId)
    if (!config || config.sourceCollection !== collectionSlug) return

    const serverUrl = (process.env.PAYLOAD_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')
    const readDoc = method === 'DELETE' ? doc : await withCategoryRead(payload, doc, config.urlTemplate)
    const request = method === 'DELETE'
        ? deleteRequest(String(doc.id))
        : (() => {
            const item = toCatalogItem(readDoc, {
                urlTemplate: config.urlTemplate,
                serverUrl,
                brand: config.brand,
            })
            return item ? updateRequest(item) : null
        })()
    if (!request) return

    const error = await pushBatch(config.catalogId, config.token, [request])
    if (error) {
        payload.logger.warn(`[MetaCatalog] ${method} ${collectionSlug} ${doc.id} failed: ${error}`)
    }
}

export async function syncCatalogCollection(
    payload: Payload,
    config: CatalogConfig,
    siteId: string | number,
): Promise<CatalogSyncResult> {
    const result: CatalogSyncResult = { synced: 0, skipped: 0, errors: [] }
    const serverUrl = (process.env.PAYLOAD_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')
    let page = 1

    for (;;) {
        const found = await payload.find({
            collection: asCollectionSlug(config.sourceCollection),
            where: { site: { equals: siteId } },
            limit: 100,
            page,
            depth: 1,
            overrideAccess: true,
        })
        const requests: CatalogBatchRequest[] = []
        for (const doc of found.docs as Array<Record<string, unknown>>) {
            const item = toCatalogItem(doc, {
                urlTemplate: config.urlTemplate,
                serverUrl,
                brand: config.brand,
            })
            if (!item) {
                result.skipped += 1
                continue
            }
            requests.push(updateRequest(item))
        }

        for (let index = 0; index < requests.length; index += 20) {
            const chunk = requests.slice(index, index + 20)
            const error = await pushBatch(config.catalogId, config.token, chunk)
            if (error) result.errors.push(error)
            else result.synced += chunk.length
        }

        if (!found.hasNextPage) break
        page += 1
    }

    return result
}
