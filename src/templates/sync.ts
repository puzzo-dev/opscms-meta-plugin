import type { Payload, PayloadRequest } from 'payload'

import { asCollectionSlug } from '../types'
import type { MetaHost } from '../types/host'
import type { ApprovalRecord, ApprovalStatus } from '../types/approvals'
import { tokenForCatalog } from '../sync/catalogSync'
import { contentHash, metaTemplateName, toMetaBody } from './body'
import { readTemplate, submitTemplate, TEMPLATE_LANGUAGE } from './graph'

/**
 * Getting a notification's WhatsApp message approved by Meta.
 *
 * When a site sends a notification by WhatsApp through Meta, the message has to be a template Meta has approved. So whenever a
 * workflow that sends a template by WhatsApp is saved, or that template's wording changes, the plugin submits the template to
 * Meta and keeps a record of where it stands. Once Meta approves it the message goes out; if Meta rejects it, or the wording
 * could not be submitted, the plugin tells the host with a `meta.template.needs_attention` event, and the host's automation
 * tells the owner.
 *
 * The plugin never owns the workflow or the wording: it reads them.
 */

export const NEEDS_ATTENTION_EVENT = 'meta.template.needs_attention'

/** The statuses that mean the message is not going out until the owner or Meta does something. */
const PROBLEM_STATUSES: ReadonlySet<ApprovalStatus> = new Set(['rejected', 'paused', 'disabled', 'invalid', 'failed'])

export interface SyncContext {
    payload: Payload
    req: PayloadRequest
    host?: MetaHost
}

interface SiteConnection {
    siteId: string | number
    siteSlug: string
    siteName: string
    organizationId: string | number | null
    wabaId: string
    token: string
}

const relationId = (value: unknown): string | number | null => {
    if (typeof value === 'number' || typeof value === 'string') return value
    if (value && typeof value === 'object') {
        const id = (value as { id?: unknown }).id
        if (typeof id === 'number' || typeof id === 'string') return id
    }
    return null
}

/** The template keys a workflow's steps send by WhatsApp. */
export function whatsappTemplateKeys(steps: unknown): string[] {
    if (!Array.isArray(steps)) return []
    const keys = new Set<string>()
    for (const step of steps as Array<Record<string, unknown>>) {
        if (step?.blockType !== 'send_notification') continue
        const channel = step.channel
        const channels = Array.isArray(channel) ? channel : typeof channel === 'string' ? [channel] : []
        const key = typeof step.template_key === 'string' ? step.template_key.trim() : ''
        if (key && channels.includes('whatsapp')) keys.add(key)
    }
    return [...keys]
}

/** The site's official WhatsApp connection: its business account and the token to act on it. Null when Meta is not its carrier. */
export async function connectionForSite(payload: Payload, siteId: string | number): Promise<SiteConnection | null> {
    const found = await payload.find({
        collection: asCollectionSlug('meta-config'),
        where: { and: [{ site: { equals: siteId } }, { isActive: { equals: true } }, { whatsappEnabled: { equals: true } }] } as never,
        limit: 1,
        depth: 1,
        overrideAccess: true,
        context: { preventMasking: true },
    })
    const config = found.docs[0] as unknown as Record<string, unknown> | undefined
    if (!config || config.authMethod !== 'oauth') return null
    const wabaId = typeof config.whatsappBusinessAccountId === 'string' ? config.whatsappBusinessAccountId.trim() : ''
    const token = tokenForCatalog(config)
    const site = config.site as { slug?: string; name?: string; siteIdentity?: { companyName?: string }; organization?: unknown } | null
    if (!wabaId || !token || !site || typeof site !== 'object' || !site.slug) return null
    return {
        siteId,
        siteSlug: site.slug,
        siteName: site.siteIdentity?.companyName?.trim() || site.name || site.slug,
        organizationId: relationId(config.organization) ?? relationId(site.organization),
        wabaId,
        token,
    }
}

/** The WhatsApp message of the notification template this site uses for a key: the site's own, else the global one. */
async function messageForKey(payload: Payload, siteId: string | number, key: string): Promise<string | null> {
    const found = await payload.find({
        collection: asCollectionSlug('notification-templates'),
        where: { and: [{ key: { equals: key } }, { or: [{ site: { equals: siteId } }, { is_global: { equals: true } }] }] } as never,
        limit: 10,
        depth: 0,
        overrideAccess: true,
    })
    const docs = found.docs as unknown as Array<{ site?: unknown; is_global?: boolean; channels?: { message?: { body?: string } } }>
    const own = docs.find((d) => relationId(d.site) === siteId)
    const chosen = own ?? docs.find((d) => d.is_global)
    const body = chosen?.channels?.message?.body
    return typeof body === 'string' && body.trim() ? body : null
}

const recordFilter = (siteId: string | number, templateKey: string, hash: string) =>
    ({ and: [{ site: { equals: siteId } }, { templateKey: { equals: templateKey } }, { contentHash: { equals: hash } }] }) as never

/** Tell the host a template needs attention, once per problem. */
async function alertOnce(ctx: SyncContext, connection: SiteConnection, record: ApprovalRecord): Promise<void> {
    if (!PROBLEM_STATUSES.has(record.status) || record.alertedStatus === record.status) return
    const { payload, req, host } = ctx
    if (!host) {
        payload.logger.warn(`[meta:templates] ${connection.siteSlug}: template "${record.templateKey}" is ${record.status}: ${record.rejectionReason ?? ''}`)
        return
    }
    try {
        if (connection.organizationId != null) await host.ensureEventHandler(payload, NEEDS_ATTENTION_EVENT, { id: connection.siteId, organizationId: connection.organizationId })
        await host.emitSystemEvent(
            payload,
            NEEDS_ATTENTION_EVENT,
            {
                siteSlug: connection.siteSlug,
                data: {
                    siteName: connection.siteName,
                    templateKey: record.templateKey,
                    status: record.status,
                    reason: record.rejectionReason || 'Meta did not give a reason.',
                    metaName: record.metaName,
                },
            },
            req,
        )
        await payload.update({ collection: asCollectionSlug('meta-approvals'), id: record.id, data: { alertedStatus: record.status } as never, overrideAccess: true, depth: 0 })
    } catch (err) {
        payload.logger.error(`[meta:templates] could not raise the alert for "${record.templateKey}" on ${connection.siteSlug}: ${err}`)
    }
}

/** Submit a record's wording to Meta and record the outcome. Used for a new record and for retrying one that failed. */
async function submitRecord(ctx: SyncContext, connection: SiteConnection, record: ApprovalRecord): Promise<ApprovalRecord> {
    const { payload } = ctx
    const converted = toMetaBody(record.body)
    // The record keeps the original wording; the converted text and its parameters are what Meta sees.
    if (!converted.ok) return updateRecord(payload, record, { status: 'invalid', rejectionReason: converted.problems.join(' ') })
    const result = await submitTemplate(connection.token, connection.wabaId, { name: record.metaName, body: converted.body, language: record.language })
    if (!result.ok) return updateRecord(payload, record, { status: 'failed', rejectionReason: result.error, parameters: converted.body.parameters as never })
    return updateRecord(payload, record, {
        status: result.status,
        metaTemplateId: result.id,
        category: result.category,
        rejectionReason: result.reason,
        parameters: converted.body.parameters as never,
        wabaId: connection.wabaId,
        alertedStatus: null,
    })
}

async function updateRecord(payload: Payload, record: ApprovalRecord, data: Record<string, unknown>): Promise<ApprovalRecord> {
    const updated = await payload.update({ collection: asCollectionSlug('meta-approvals'), id: record.id, data: data as never, overrideAccess: true, depth: 0 })
    return updated as unknown as ApprovalRecord
}

/**
 * Make sure every WhatsApp template a site uses has been submitted to Meta in its current wording. Does nothing for a site whose
 * carrier is not Meta, and nothing for a template already submitted, so it is safe to call whenever something might have changed.
 */
export async function syncSiteTemplates(ctx: SyncContext, siteId: string | number, keys: string[]): Promise<void> {
    const { payload } = ctx
    if (keys.length === 0) return
    const connection = await connectionForSite(payload, siteId)
    if (!connection) return

    for (const key of new Set(keys)) {
        try {
            const message = await messageForKey(payload, siteId, key)
            if (message == null) {
                payload.logger.warn(`[meta:templates] ${connection.siteSlug}: no WhatsApp message is written for template "${key}"`)
                continue
            }
            const hash = contentHash(message)
            const existing = await payload.find({ collection: asCollectionSlug('meta-approvals'), where: recordFilter(siteId, key, hash), limit: 1, depth: 0, overrideAccess: true })
            const found = existing.docs[0] as unknown as ApprovalRecord | undefined
            if (found) {
                // Submitted already. Only one that could not be submitted is tried again; a problem the owner has to fix stays put.
                if (found.status === 'failed') await alertOnce(ctx, connection, await submitRecord(ctx, connection, found))
                continue
            }
            let created: ApprovalRecord
            try {
                created = (await payload.create({
                    collection: asCollectionSlug('meta-approvals'),
                    data: {
                        site: siteId,
                        templateKey: key,
                        contentHash: hash,
                        metaName: metaTemplateName(siteId, key, hash),
                        language: TEMPLATE_LANGUAGE,
                        status: 'pending',
                        body: message,
                        wabaId: connection.wabaId,
                    } as never,
                    overrideAccess: true,
                    depth: 0,
                })) as unknown as ApprovalRecord
            } catch (err) {
                // Two saves at once both found nothing; the other one made the row and will submit it.
                if (/unique|duplicate/i.test(String(err))) continue
                throw err
            }
            await alertOnce(ctx, connection, await submitRecord(ctx, connection, created))
        } catch (err) {
            payload.logger.error(`[meta:templates] ${connection.siteSlug}: could not prepare template "${key}": ${err}`)
        }
    }
}

/** Every WhatsApp template the site's workflows use. For when a site first connects its number. */
export async function syncAllTemplatesForSite(ctx: SyncContext, siteId: string | number): Promise<void> {
    const found = await ctx.payload.find({ collection: asCollectionSlug('workflows'), where: { site: { equals: siteId } } as never, limit: 200, depth: 0, overrideAccess: true })
    const keys = (found.docs as unknown as Array<{ steps?: unknown }>).flatMap((workflow) => whatsappTemplateKeys(workflow.steps))
    await syncSiteTemplates(ctx, siteId, keys)
}

/** A template's wording changed: resubmit it for the sites whose workflows send it by WhatsApp. */
export async function syncAfterTemplateChange(ctx: SyncContext, template: { key?: unknown; site?: unknown; is_global?: unknown }): Promise<void> {
    const key = typeof template.key === 'string' ? template.key : ''
    if (!key) return
    const ownSite = template.is_global ? null : relationId(template.site)
    const found = await ctx.payload.find({
        collection: asCollectionSlug('workflows'),
        where: { 'steps.template_key': { equals: key } } as never,
        limit: 200,
        depth: 0,
        overrideAccess: true,
    })
    const sites = new Set<string | number>()
    for (const workflow of found.docs as unknown as Array<{ site?: unknown; steps?: unknown }>) {
        const site = relationId(workflow.site)
        if (site == null || (ownSite != null && site !== ownSite)) continue
        if (whatsappTemplateKeys(workflow.steps).includes(key)) sites.add(site)
    }
    for (const site of sites) await syncSiteTemplates(ctx, site, [key])
}

/** Meta says where a template stands now (from its webhook or from asking). Record it, and raise the alert if it is a problem. */
export async function applyStatusChange(
    ctx: SyncContext,
    record: ApprovalRecord,
    change: { status: ApprovalStatus; category?: string | null; reason?: string | null },
): Promise<void> {
    const siteId = relationId(record.site)
    if (siteId == null) return
    const data: Record<string, unknown> = { status: change.status }
    if (change.category) data.category = change.category
    data.rejectionReason = change.reason ?? (change.status === 'approved' ? null : record.rejectionReason)
    if (change.status === 'approved' || change.status === 'pending') data.alertedStatus = null
    const updated = await updateRecord(ctx.payload, record, data)
    const connection = await connectionForSite(ctx.payload, siteId)
    if (connection) await alertOnce(ctx, connection, updated)
}

/** The record Meta's report is about: found by Meta's id, else by the name the plugin gave it. */
export async function findRecordForReport(payload: Payload, report: { templateId?: string | null; templateName?: string | null }): Promise<ApprovalRecord | null> {
    const clauses: Array<Record<string, unknown>> = []
    if (report.templateId) clauses.push({ metaTemplateId: { equals: report.templateId } })
    if (report.templateName) clauses.push({ metaName: { equals: report.templateName } })
    if (clauses.length === 0) return null
    const found = await payload.find({ collection: asCollectionSlug('meta-approvals'), where: { or: clauses } as never, limit: 1, depth: 0, overrideAccess: true })
    return (found.docs[0] as unknown as ApprovalRecord | undefined) ?? null
}

/** Ask Meta about the templates still in review, and retry the ones that could not be submitted. Run on a schedule. */
export async function checkPendingTemplates(ctx: SyncContext, limit = 50): Promise<{ checked: number; changed: number; retried: number }> {
    const { payload } = ctx
    const result = { checked: 0, changed: 0, retried: 0 }
    const found = await payload.find({
        collection: asCollectionSlug('meta-approvals'),
        where: { status: { in: ['pending', 'failed'] } } as never,
        limit,
        depth: 0,
        sort: 'updatedAt',
        overrideAccess: true,
    })
    for (const record of found.docs as unknown as ApprovalRecord[]) {
        const siteId = relationId(record.site)
        if (siteId == null) continue
        try {
            const connection = await connectionForSite(payload, siteId)
            if (!connection) continue
            if (record.status === 'failed') {
                result.retried += 1
                await alertOnce(ctx, connection, await submitRecord(ctx, connection, record))
                continue
            }
            if (!record.metaTemplateId) continue
            result.checked += 1
            const read = await readTemplate(connection.token, record.metaTemplateId)
            if (!read.ok) {
                payload.logger.warn(`[meta:templates] could not read "${record.templateKey}" on ${connection.siteSlug}: ${read.error}`)
                continue
            }
            if (read.status !== record.status) {
                result.changed += 1
                await applyStatusChange(ctx, record, { status: read.status, category: read.category, reason: read.reason })
            }
        } catch (err) {
            payload.logger.error(`[meta:templates] check of "${record.templateKey}" failed: ${err}`)
        }
    }
    return result
}
