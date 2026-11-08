import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Payload, PayloadRequest } from 'payload'

import { metaWhatsAppChannel } from '../channels/whatsapp'
import type { MetaHost } from '../types/host'
import { applyStatusChange, checkPendingTemplates, findRecordForReport, syncAfterTemplateChange, syncSiteTemplates, whatsappTemplateKeys } from './sync'

/**
 * The whole path from "a workflow sends this template by WhatsApp" to "Meta approved it, so it is sent" or "it was refused, so
 * the owner is told". Payload is an in-memory fake; Meta is a fake fetch that answers the way its Graph API does.
 */

type Doc = Record<string, any>

function matches(doc: Doc, where: any): boolean {
    if (!where) return true
    if (where.and) return where.and.every((w: any) => matches(doc, w))
    if (where.or) return where.or.some((w: any) => matches(doc, w))
    return Object.entries(where).every(([field, cond]: [string, any]) => {
        // A dotted path reaches into blocks the fake does not model; the real query matches on it, so the fake lets it through.
        if (field.includes('.')) return true
        const raw = doc[field]
        const value = raw && typeof raw === 'object' && 'id' in raw ? raw.id : raw
        if ('equals' in cond) return value === cond.equals
        if ('in' in cond) return cond.in.includes(value)
        return true
    })
}

function fakePayload(initial: Record<string, Doc[]>) {
    const db: Record<string, Doc[]> = { 'meta-config': [], 'notification-templates': [], 'meta-approvals': [], workflows: [], ...initial }
    let nextId = 100
    const payload = {
        logger: { warn() {}, error() {}, info() {} },
        find: async ({ collection, where, limit, sort }: any) => {
            let docs = (db[collection] ?? []).filter((d) => matches(d, where))
            if (sort === '-createdAt') docs = [...docs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
            return { docs: limit ? docs.slice(0, limit) : docs, totalDocs: docs.length }
        },
        create: async ({ collection, data }: any) => {
            const rows = (db[collection] ??= [])
            if (collection === 'meta-approvals' && rows.some((r) => r.site === data.site && r.templateKey === data.templateKey && r.contentHash === data.contentHash)) {
                throw new Error('duplicate key value violates unique constraint')
            }
            const doc = { id: nextId++, createdAt: new Date().toISOString(), ...data }
            rows.push(doc)
            return doc
        },
        update: async ({ collection, id, data }: any) => {
            const doc = db[collection].find((d) => d.id === id)!
            Object.assign(doc, data)
            return doc
        },
    } as unknown as Payload
    return { payload, db }
}

const SITE = { id: 7, slug: 'shop', name: 'Shop', siteIdentity: { companyName: 'The Shop' }, organization: 3 }
const connectedConfig = (): Doc => ({
    id: 1, site: SITE, organization: 3, isActive: true, whatsappEnabled: true, authMethod: 'oauth',
    whatsappBusinessAccountId: '2241717123267645', oauthUserAccessToken: 'customer-token',
})
const template = (key: string, body: string, extra: Doc = {}): Doc => ({ id: 50, key, site: 7, channels: { message: { body } }, ...extra })
const GOOD = 'Hi {{doc.values.first_name}}, we have received your enquiry and will contact you shortly.'

let graphCalls: Array<{ method: string; url: string; body?: any }>
let graphReply: (call: { method: string; url: string; body?: any }) => { status: number; json: unknown }
const realFetch = globalThis.fetch

beforeEach(() => {
    graphCalls = []
    graphReply = (call) => (call.method === 'POST' ? { status: 200, json: { id: '9001', status: 'PENDING', category: 'UTILITY' } } : { status: 200, json: { status: 'APPROVED', category: 'UTILITY' } })
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const call = { method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined }
        graphCalls.push(call)
        const reply = graphReply(call)
        return new Response(JSON.stringify(reply.json), { status: reply.status })
    }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

function setup(extra: Record<string, Doc[]> = {}, connected = true) {
    const { payload, db } = fakePayload({ 'meta-config': connected ? [connectedConfig()] : [], 'notification-templates': [template('enquiry_received', GOOD)], ...extra })
    const events: Array<{ eventName: string; siteSlug: string; data: Record<string, unknown> }> = []
    const handlers: string[] = []
    const host: MetaHost = {
        emitSystemEvent: async (_p, eventName, event) => { events.push({ eventName, siteSlug: event.siteSlug, data: event.data }); return { enqueued: 1, failed: 0 } },
        ensureEventHandler: async (_p, eventName) => { handlers.push(eventName) },
    }
    const ctx = { payload, req: { payload } as unknown as PayloadRequest, host }
    return { payload, db, events, handlers, ctx }
}

describe('which templates a workflow sends by WhatsApp', () => {
    it('reads the template keys of send_notification steps that include WhatsApp', () => {
        assert.deepEqual(whatsappTemplateKeys([
            { blockType: 'send_notification', channel: ['whatsapp', 'email'], template_key: 'a' },
            { blockType: 'send_notification', channel: ['email'], template_key: 'b' },
            { blockType: 'send_notification', channel: 'whatsapp', template_key: 'c' },
            { blockType: 'trigger_erp', channel: ['whatsapp'], template_key: 'd' },
            { blockType: 'send_notification', channel: ['whatsapp'] },
        ]), ['a', 'c'])
        assert.deepEqual(whatsappTemplateKeys(undefined), [])
    })
})

describe('submitting a template', () => {
    it('does nothing for a site whose WhatsApp carrier is not Meta', async () => {
        const { ctx, db } = setup({}, false)
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        assert.equal(graphCalls.length, 0)
        assert.equal(db['meta-approvals'].length, 0)
    })

    it('submits the user\'s own template, with named placeholders, and records it as in review', async () => {
        const { ctx, db } = setup()
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        assert.equal(graphCalls.length, 1)
        const call = graphCalls[0]
        assert.match(call.url, /\/2241717123267645\/message_templates$/)
        assert.equal(call.body.parameter_format, 'NAMED')
        assert.equal(call.body.category, 'UTILITY')
        assert.match(call.body.name, /^opscms_7_enquiry_received_[0-9a-f]{8}$/)
        assert.equal(call.body.components[0].text, 'Hi {{doc_values_first_name}}, we have received your enquiry and will contact you shortly.')
        assert.deepEqual(call.body.components[0].example.body_text_named_params.map((p: any) => p.param_name), ['doc_values_first_name'])
        const [record] = db['meta-approvals']
        assert.equal(record.status, 'pending')
        assert.equal(record.metaTemplateId, '9001')
        assert.deepEqual(record.parameters.map((p: any) => [p.name, p.path]), [['doc_values_first_name', 'doc.values.first_name']])
    })

    it('does not submit the same wording twice, and submits changed wording as a new template', async () => {
        const { ctx, db } = setup()
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        assert.equal(graphCalls.length, 1)
        db['notification-templates'][0].channels.message.body = 'Hello {{doc.values.first_name}}, thank you for your enquiry, we will call you back shortly.'
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        assert.equal(graphCalls.length, 2)
        assert.equal(db['meta-approvals'].length, 2)
    })

    it('prefers the site\'s own template over the global one of the same key', async () => {
        const { ctx } = setup({ 'notification-templates': [
            template('enquiry_received', 'Global wording {{x}} is here for everybody to read now.', { id: 1, site: undefined, is_global: true }),
            template('enquiry_received', GOOD, { id: 2 }),
        ] })
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        assert.match(graphCalls[0].body.components[0].text, /^Hi \{\{doc_values_first_name\}\}/)
    })

    it('tells the owner, once, when the wording is something Meta would refuse, without bothering Meta', async () => {
        const { ctx, db, events, handlers } = setup({ 'notification-templates': [template('enquiry_received', '{{doc.values.first_name}} your enquiry is received.')] })
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        assert.equal(graphCalls.length, 0)
        assert.equal(db['meta-approvals'][0].status, 'invalid')
        assert.equal(events.length, 1)
        assert.equal(events[0].eventName, 'meta.template.needs_attention')
        assert.equal(events[0].siteSlug, 'shop')
        assert.equal(events[0].data.templateKey, 'enquiry_received')
        assert.equal(events[0].data.siteName, 'The Shop')
        assert.match(String(events[0].data.reason), /cannot start with a variable/)
        assert.deepEqual(handlers, ['meta.template.needs_attention'])
    })

    it('tells the owner when Meta rejects it at once', async () => {
        graphReply = () => ({ status: 200, json: { id: '9002', status: 'REJECTED', category: 'MARKETING' } })
        const { ctx, db, events } = setup()
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        assert.equal(db['meta-approvals'][0].status, 'rejected')
        assert.equal(events.length, 1)
        assert.equal(events[0].data.status, 'rejected')
    })

    it('tells the owner when the template could not be submitted, and tries again later', async () => {
        graphReply = () => ({ status: 400, json: { error: { message: 'WhatsApp business account restricted from creating a new template' } } })
        const { ctx, db, events } = setup()
        await syncSiteTemplates(ctx, 7, ['enquiry_received'])
        assert.equal(db['meta-approvals'][0].status, 'failed')
        assert.match(db['meta-approvals'][0].rejectionReason, /restricted/)
        assert.equal(events.length, 1)

        graphReply = () => ({ status: 200, json: { id: '9003', status: 'PENDING', category: 'UTILITY' } })
        const result = await checkPendingTemplates(ctx)
        assert.equal(result.retried, 1)
        assert.equal(db['meta-approvals'][0].status, 'pending')
        assert.equal(db['meta-approvals'][0].metaTemplateId, '9003')
    })

    it('resubmits a changed template only for sites whose workflows send it by WhatsApp', async () => {
        const { ctx, db } = setup({ workflows: [
            { id: 1, site: 7, steps: [{ blockType: 'send_notification', channel: ['whatsapp'], template_key: 'enquiry_received' }] },
            { id: 2, site: 8, steps: [{ blockType: 'send_notification', channel: ['whatsapp'], template_key: 'enquiry_received' }] },
            { id: 3, site: 9, steps: [{ blockType: 'send_notification', channel: ['email'], template_key: 'enquiry_received' }] },
        ] })
        await syncAfterTemplateChange(ctx, { key: 'enquiry_received', site: 7 })
        assert.equal(db['meta-approvals'].length, 1)
        assert.equal(db['meta-approvals'][0].site, 7)
    })
})

describe('what Meta says afterwards', () => {
    async function submitted() {
        const s = setup()
        await syncSiteTemplates(s.ctx, 7, ['enquiry_received'])
        return s
    }

    it('records an approval found by asking Meta, and says nothing to the owner', async () => {
        const { ctx, db, events } = await submitted()
        const result = await checkPendingTemplates(ctx)
        assert.deepEqual(result, { checked: 1, changed: 1, retried: 0 })
        assert.equal(db['meta-approvals'][0].status, 'approved')
        assert.equal(events.length, 0)
    })

    it('leaves a template that is still in review alone', async () => {
        const { ctx, db } = await submitted()
        graphReply = () => ({ status: 200, json: { status: 'PENDING' } })
        assert.equal((await checkPendingTemplates(ctx)).changed, 0)
        assert.equal(db['meta-approvals'][0].status, 'pending')
    })

    it('records a rejection from the webhook and tells the owner with Meta\'s reason', async () => {
        const { ctx, db, events } = await submitted()
        const record = await findRecordForReport(ctx.payload, { templateId: '9001', templateName: null })
        assert.ok(record)
        await applyStatusChange(ctx, record as never, { status: 'rejected', reason: 'INVALID_FORMAT' })
        assert.equal(db['meta-approvals'][0].status, 'rejected')
        assert.equal(events.length, 1)
        assert.equal(events[0].data.reason, 'INVALID_FORMAT')
    })

    it('tells the owner of one problem only once, but again if it comes back after an approval', async () => {
        const { ctx, db, events } = await submitted()
        const record = () => db['meta-approvals'][0]
        await applyStatusChange(ctx, record() as never, { status: 'paused', reason: 'LOW_QUALITY' })
        await applyStatusChange(ctx, record() as never, { status: 'paused', reason: 'LOW_QUALITY' })
        assert.equal(events.length, 1)
        await applyStatusChange(ctx, record() as never, { status: 'approved' })
        await applyStatusChange(ctx, record() as never, { status: 'paused', reason: 'LOW_QUALITY' })
        assert.equal(events.length, 2)
    })

    it('finds the record by the name the plugin gave it when Meta\'s id is not known', async () => {
        const { ctx, db } = await submitted()
        const found = await findRecordForReport(ctx.payload, { templateId: null, templateName: db['meta-approvals'][0].metaName })
        assert.equal(found?.id, db['meta-approvals'][0].id)
        assert.equal(await findRecordForReport(ctx.payload, { templateId: null, templateName: null }), null)
    })
})

describe('sending through Meta', () => {
    const sent: any[] = []
    const send = async (db: Record<string, Doc[]>, variables: Record<string, unknown>, templateKey: string | null = 'enquiry_received') => {
        const { payload } = fakePayload(db)
        sent.length = 0
        globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 200 }) }) as typeof fetch
        return metaWhatsAppChannel.send({ payload, config: { phoneNumberId: '1', accessToken: 't', siteId: 7 }, to: '2348031234567', message: 'free text', templateKey: templateKey ?? undefined, variables })
    }
    const record = (status: string, extra: Doc = {}): Doc => ({
        id: 1, site: 7, templateKey: 'enquiry_received', contentHash: 'h', metaName: 'opscms_7_enquiry_received_abcd1234', language: 'en_US', status,
        parameters: [{ name: 'doc_values_first_name', path: 'doc.values.first_name', example: 'x' }], createdAt: '2026-11-07T10:00:00Z', ...extra,
    })

    it('names the approved template and gives the values by name', async () => {
        const outcome = await send({ 'meta-approvals': [record('approved')] }, { doc: { values: { first_name: 'Ada' } } })
        assert.deepEqual(outcome, { success: true })
        assert.deepEqual(sent[0].template, {
            name: 'opscms_7_enquiry_received_abcd1234',
            language: { code: 'en_US' },
            components: [{ type: 'body', parameters: [{ type: 'text', parameter_name: 'doc_values_first_name', text: 'Ada' }] }],
        })
    })

    it('holds the message while the template is in review', async () => {
        const outcome = await send({ 'meta-approvals': [record('pending')] }, {})
        assert.equal(outcome.success, false)
        assert.equal(outcome.deferred, true)
        assert.match(outcome.error ?? '', /still with Meta for review/)
        assert.equal(sent.length, 0)
    })

    it('refuses, with the reason, a template Meta did not approve', async () => {
        const outcome = await send({ 'meta-approvals': [record('rejected', { rejectionReason: 'INVALID_FORMAT' })] }, {})
        assert.equal(outcome.success, false)
        assert.equal(outcome.deferred, false)
        assert.match(outcome.error ?? '', /Meta rejected it \(INVALID_FORMAT\)/)
        assert.equal(sent.length, 0)
    })

    it('uses the newest wording, never an older approved one in its place', async () => {
        const outcome = await send({ 'meta-approvals': [record('approved', { id: 1 }), record('pending', { id: 2, createdAt: '2026-11-07T11:00:00Z' })] }, {})
        assert.equal(outcome.deferred, true)
    })

    it('says so when the template was never submitted, and sends free text when there is no template key', async () => {
        const none = await send({ 'meta-approvals': [] }, {})
        assert.equal(none.success, false)
        assert.match(none.error ?? '', /has not been submitted to Meta yet/)
        const free = await send({ 'meta-approvals': [] }, {}, null)
        assert.equal(free.success, true)
        assert.equal(sent[0].type, 'text')
    })

    it('puts a dash where the workflow had no value, because Meta refuses an empty one', async () => {
        await send({ 'meta-approvals': [record('approved')] }, {})
        assert.equal(sent[0].template.components[0].parameters[0].text, '-')
    })
})
