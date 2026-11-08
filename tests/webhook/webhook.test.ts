import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Payload, PayloadRequest } from 'payload'

import { createMetaWebhookEndpoints } from '../../src/endpoints/metaWebhook'
import type { MetaHost } from '../../src/types/host'
import { subscribeWabaToApp, unsubscribeWabaFromApp } from '../../src/utils/wabaSubscription'
import { handshakeChallenge, signatureMatches } from '../../src/webhook/signature'
import { templateEventsFrom } from '../../src/webhook/templateEvents'

const SECRET = 'app-secret-for-tests'
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

describe('the handshake', () => {
    it('answers the challenge when the token is the platform\'s', () => {
        assert.equal(handshakeChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '12345' }, 'tok'), '12345')
    })

    it('refuses a wrong token, a wrong mode, a missing challenge and an unconfigured server', () => {
        assert.equal(handshakeChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }, 'tok'), null)
        assert.equal(handshakeChallenge({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'tok', 'hub.challenge': '1' }, 'tok'), null)
        assert.equal(handshakeChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok' }, 'tok'), null)
        assert.equal(handshakeChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }, undefined), null)
    })
})

describe('the signature', () => {
    it('accepts Meta\'s signature of exactly this body', () => {
        assert.equal(signatureMatches('{"a":1}', sign('{"a":1}'), SECRET), true)
    })

    it('refuses another body, another secret, a missing or malformed header', () => {
        assert.equal(signatureMatches('{"a":2}', sign('{"a":1}'), SECRET), false)
        assert.equal(signatureMatches('{"a":1}', sign('{"a":1}', 'other'), SECRET), false)
        assert.equal(signatureMatches('{"a":1}', null, SECRET), false)
        assert.equal(signatureMatches('{"a":1}', 'sha256=zz', SECRET), false)
        assert.equal(signatureMatches('{"a":1}', sign('{"a":1}').replace('sha256=', ''), SECRET), false)
        assert.equal(signatureMatches('{"a":1}', sign('{"a":1}'), ''), false)
    })
})

const delivery = (changes: unknown[], id = '2241717123267645') => ({ object: 'whatsapp_business_account', entry: [{ id, time: 1730000000, changes }] })
const statusChange = (event: string, extra: Record<string, unknown> = {}) => ({
    field: 'message_template_status_update',
    value: { event, message_template_id: '9285879444777077', message_template_name: 'order_ready', message_template_language: 'en_US', ...extra },
})

describe('reading a delivery', () => {
    it('turns a template approval into an event for that business account', () => {
        const [event] = templateEventsFrom(delivery([statusChange('APPROVED')]))
        assert.equal(event.eventName, 'meta.template.status_changed')
        assert.equal(event.wabaId, '2241717123267645')
        assert.deepEqual({ ...event.data, eventId: undefined }, {
            field: 'message_template_status_update',
            eventId: undefined,
            wabaId: '2241717123267645',
            templateId: '9285879444777077',
            templateName: 'order_ready',
            language: 'en_US',
            status: 'APPROVED',
            reason: null,
        })
    })

    it('carries Meta\'s reason for a rejection', () => {
        const [event] = templateEventsFrom(delivery([statusChange('REJECTED', { reason: 'INVALID_FORMAT' })]))
        assert.equal(event.data.status, 'REJECTED')
        assert.equal(event.data.reason, 'INVALID_FORMAT')
    })

    it('maps recategorisation and quality changes, and ignores everything else Meta may send', () => {
        const events = templateEventsFrom(delivery([
            { field: 'template_category_update', value: { message_template_id: 1, new_category: 'MARKETING' } },
            { field: 'message_template_quality_update', value: { message_template_id: 1, new_quality_score: 'RED' } },
            { field: 'phone_number_quality_update', value: { current_limit: 'TIER_1K' } },
            { field: 'messages', value: {} },
        ]))
        assert.deepEqual(events.map((e) => [e.eventName, e.data.status]), [
            ['meta.template.category_changed', 'MARKETING'],
            ['meta.template.quality_changed', 'RED'],
        ])
    })

    it('gives the same event id to a delivery Meta repeats, and a different one to a different change', () => {
        const a = templateEventsFrom(delivery([statusChange('APPROVED')]))[0].data.eventId
        const b = templateEventsFrom(delivery([statusChange('APPROVED')]))[0].data.eventId
        const c = templateEventsFrom(delivery([statusChange('REJECTED')]))[0].data.eventId
        assert.equal(a, b)
        assert.notEqual(a, c)
    })

    it('reads nothing from a body that is not a WhatsApp business account delivery', () => {
        assert.deepEqual(templateEventsFrom(null), [])
        assert.deepEqual(templateEventsFrom({ object: 'page', entry: [] }), [])
        assert.deepEqual(templateEventsFrom({ object: 'whatsapp_business_account', entry: 'x' }), [])
    })
})

describe('the endpoint', () => {
    let emitted: Array<{ eventName: string; siteSlug: string; data: Record<string, unknown> }>
    let hostFails: boolean
    const host: MetaHost = {
        emitSystemEvent: async (_p, eventName, event) => {
            if (hostFails) throw new Error('engine down')
            emitted.push({ eventName, siteSlug: event.siteSlug, data: event.data })
            return { enqueued: 1, failed: 0 }
        },
        ensureEventHandler: async () => {},
    }
    const configs = [{ site: { slug: 'shop' } }, { site: { slug: 'shop-two' } }, { site: 7 }]
    const payload = {
        logger: { warn() {}, error() {}, info() {} },
        find: async (args: { where: unknown }) => ({ docs: JSON.stringify(args.where).includes('2241717123267645') ? configs : [] }),
    } as unknown as Payload

    beforeEach(() => {
        emitted = []
        hostFails = false
        process.env.META_APP_ID = 'app-id'
        process.env.META_APP_SECRET = SECRET
        process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-me'
    })
    afterEach(() => {
        delete process.env.META_APP_ID
        delete process.env.META_APP_SECRET
        delete process.env.META_WEBHOOK_VERIFY_TOKEN
    })

    const [handshake, receive] = createMetaWebhookEndpoints(host)
    const post = (body: string, signature: string | null, endpoint = receive) =>
        endpoint.handler({
            payload,
            text: async () => body,
            headers: new Headers(signature ? { 'x-hub-signature-256': signature } : {}),
        } as unknown as PayloadRequest)

    it('answers Meta\'s handshake with the challenge as plain text', async () => {
        const res = await handshake.handler({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': 'abc' } } as unknown as PayloadRequest)
        assert.equal(res.status, 200)
        assert.equal(await res.text(), 'abc')
        const wrong = await handshake.handler({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': 'abc' } } as unknown as PayloadRequest)
        assert.equal(wrong.status, 403)
    })

    it('refuses an unsigned or wrongly signed delivery without reading it', async () => {
        const body = JSON.stringify(delivery([statusChange('APPROVED')]))
        assert.equal((await post(body, null)).status, 401)
        assert.equal((await post(body, sign(body, 'other'))).status, 401)
        assert.equal(emitted.length, 0)
    })

    it('refuses every delivery when the server has no Meta app secret', async () => {
        delete process.env.META_APP_SECRET
        const body = JSON.stringify(delivery([statusChange('APPROVED')]))
        assert.equal((await post(body, sign(body))).status, 503)
    })

    it('hands an approval to the host once for each site that connected that business account', async () => {
        const body = JSON.stringify(delivery([statusChange('APPROVED')]))
        const res = await post(body, sign(body))
        assert.equal(res.status, 200)
        assert.deepEqual(emitted.map((e) => [e.eventName, e.siteSlug]), [
            ['meta.template.status_changed', 'shop'],
            ['meta.template.status_changed', 'shop-two'],
        ])
        assert.equal(emitted[0].data.status, 'APPROVED')
    })

    it('accepts a delivery about a business account no site has connected, and tells nobody', async () => {
        const body = JSON.stringify(delivery([statusChange('APPROVED')], '999'))
        assert.equal((await post(body, sign(body))).status, 200)
        assert.equal(emitted.length, 0)
    })

    it('answers 500 when the host fails, so Meta sends the delivery again', async () => {
        hostFails = true
        const body = JSON.stringify(delivery([statusChange('REJECTED', { reason: 'X' })]))
        assert.equal((await post(body, sign(body))).status, 500)
    })

    it('rejects a signed body that is not JSON', async () => {
        const body = 'not json'
        assert.equal((await post(body, sign(body))).status, 400)
    })

    it('still checks and accepts deliveries when the host gave no engine', async () => {
        const [, receiveWithoutHost] = createMetaWebhookEndpoints()
        const body = JSON.stringify(delivery([statusChange('APPROVED')]))
        const res = await post(body, sign(body), receiveWithoutHost)
        assert.equal(res.status, 200)
        assert.equal(emitted.length, 0)
    })
})

describe('subscribing a customer\'s business account', () => {
    const realFetch = globalThis.fetch
    let calls: Array<{ url: string; method?: string; auth?: string }>
    let status: number
    beforeEach(() => {
        calls = []
        status = 200
        globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
            calls.push({ url: String(url), method: init?.method, auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
            return new Response(status === 200 ? '{"success":true}' : JSON.stringify({ error: { message: 'Permissions error' } }), { status })
        }) as typeof fetch
    })
    afterEach(() => { globalThis.fetch = realFetch })

    it('posts to the account\'s subscribed apps with the customer\'s own token', async () => {
        assert.deepEqual(await subscribeWabaToApp('customer-token', '2241717123267645'), { ok: true })
        assert.match(calls[0].url, /\/2241717123267645\/subscribed_apps$/)
        assert.equal(calls[0].method, 'POST')
        assert.equal(calls[0].auth, 'Bearer customer-token')
    })

    it('removes the subscription on disconnect', async () => {
        assert.deepEqual(await unsubscribeWabaFromApp('customer-token', '2241717123267645'), { ok: true })
        assert.equal(calls[0].method, 'DELETE')
    })

    it('reports Meta\'s reason when it refuses, and does not call Meta without a token or account', async () => {
        status = 403
        assert.deepEqual(await subscribeWabaToApp('t', '1'), { ok: false, error: 'Permissions error' })
        calls = []
        assert.equal((await subscribeWabaToApp('', '1')).ok, false)
        assert.equal((await unsubscribeWabaFromApp('t', '')).ok, false)
        assert.equal(calls.length, 0)
    })
})
