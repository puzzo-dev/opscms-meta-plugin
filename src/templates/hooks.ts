import type { CollectionConfig, Field, PayloadRequest } from 'payload'

import { asCollectionSlug } from '../types'
import type { ApprovalRecord } from '../types/approvals'

import type { MetaHost } from '../types/host'
import { syncAfterTemplateChange, syncSiteTemplates, whatsappTemplateKeys } from './sync'

/**
 * When the plugin looks at the host's notifications.
 *
 *  - A workflow is saved: if it sends a template by WhatsApp, that template is submitted to Meta (for sites whose carrier is Meta).
 *  - A notification template's wording is saved: the sites whose workflows send it by WhatsApp resubmit it, because Meta approves
 *    exact wording.
 *
 * Both run a moment after the save has committed and never hold up, or fail, the save: the plugin reads the host's collections
 * and writes only its own.
 */

const AFTER_COMMIT_MS = 2000

const STATUS_WORDS: Record<string, string> = {
    pending: 'with Meta for review',
    approved: 'approved',
    rejected: 'rejected by Meta',
    paused: 'paused by Meta',
    disabled: 'disabled by Meta',
    invalid: 'not submitted: the wording does not follow Meta\'s rules',
    failed: 'could not be submitted yet',
}

/**
 * What the owner reads on the template itself: where Meta stands on it, for each of their sites that sends it by WhatsApp.
 * Read through the signed-in person's own access, so a global template never shows one site another site's status.
 */
async function approvalSummary(req: PayloadRequest, templateKey: unknown): Promise<string> {
    if (typeof templateKey !== 'string' || !templateKey || !req.user) return ''
    const found = await req.payload.find({
        collection: asCollectionSlug('meta-approvals'),
        where: { templateKey: { equals: templateKey } } as never,
        sort: '-createdAt',
        limit: 50,
        depth: 1,
        user: req.user,
        overrideAccess: false,
    })
    const latestBySite = new Map<string, ApprovalRecord & { site: { name?: string; slug?: string } | number | string }>()
    for (const row of found.docs as unknown as Array<ApprovalRecord & { site: { id?: string | number; name?: string; slug?: string } | number | string }>) {
        const id = typeof row.site === 'object' && row.site ? String(row.site.id) : String(row.site)
        if (!latestBySite.has(id)) latestBySite.set(id, row)
    }
    return [...latestBySite.values()]
        .map((row) => {
            const site = typeof row.site === 'object' && row.site ? row.site.name || row.site.slug || 'A site' : `Site ${row.site}`
            const why = row.rejectionReason && row.status !== 'approved' && row.status !== 'pending' ? `: ${row.rejectionReason}` : ''
            return `${site} — ${STATUS_WORDS[row.status] ?? row.status}${why}`
        })
        .join('\n')
}

/** The read-only line on a notification template. It is computed, not stored: the template has no column for it. */
const whatsappDeliveryField: Field = {
    name: 'whatsappDelivery',
    type: 'textarea',
    label: 'WhatsApp delivery through Meta',
    virtual: true,
    admin: {
        readOnly: true,
        description:
            'When a site sends this message by WhatsApp through Meta, Meta must approve its exact wording first. This shows where it stands for your sites. Change the text and it is sent to Meta again.',
    },
    hooks: {
        afterRead: [
            async ({ req, siblingData, data }) => {
                try {
                    return await approvalSummary(req, (siblingData as { key?: unknown } | undefined)?.key ?? (data as { key?: unknown } | undefined)?.key)
                } catch (err) {
                    req.payload.logger.warn(`[meta:templates] could not read a template's approval status: ${err}`)
                    return ''
                }
            },
        ],
    },
}

const relationId = (value: unknown): string | number | null => {
    if (typeof value === 'number' || typeof value === 'string') return value
    if (value && typeof value === 'object') {
        const id = (value as { id?: unknown }).id
        if (typeof id === 'number' || typeof id === 'string') return id
    }
    return null
}

function inBackground(req: PayloadRequest, label: string, work: () => Promise<void>): void {
    setTimeout(() => {
        work().catch((err: unknown) => req.payload.logger.error(`[meta:templates] ${label} failed: ${err}`))
    }, AFTER_COMMIT_MS)
}

export function attachTemplateHooks(collection: CollectionConfig, host?: MetaHost): CollectionConfig {
    if (collection.slug === 'workflows') {
        return {
            ...collection,
            hooks: {
                ...collection.hooks,
                afterChange: [
                    ...(collection.hooks?.afterChange ?? []),
                    ({ doc, req }) => {
                        const siteId = relationId((doc as { site?: unknown }).site)
                        const keys = whatsappTemplateKeys((doc as { steps?: unknown }).steps)
                        if (siteId != null && keys.length > 0) {
                            inBackground(req, 'submitting the workflow\'s templates', () => syncSiteTemplates({ payload: req.payload, req, host }, siteId, keys))
                        }
                        return doc
                    },
                ],
            },
        }
    }
    if (collection.slug === 'notification-templates') {
        return {
            ...collection,
            fields: [...collection.fields, whatsappDeliveryField],
            hooks: {
                ...collection.hooks,
                afterChange: [
                    ...(collection.hooks?.afterChange ?? []),
                    ({ doc, req }) => {
                        inBackground(req, 'resubmitting a changed template', () => syncAfterTemplateChange({ payload: req.payload, req, host }, doc as Record<string, unknown>))
                        return doc
                    },
                ],
            },
        }
    }
    return collection
}
