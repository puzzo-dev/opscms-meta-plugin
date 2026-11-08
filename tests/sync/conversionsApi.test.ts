import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

import { sendConversionEvent } from '../../src/sync/conversionsApi.js'
import type { MetaCredentials } from '../../src/types.js'

/**
 * The Conversions API sends purchase and lead events from this server directly
 * to Meta, so it carries real customer data and real money figures.
 *
 * The rule that matters most: personal data must reach Meta only as a SHA-256
 * hash. The caller hashes it, and this function must never send a raw email or
 * phone number under any circumstances. The second rule is that a failure to
 * reach Meta must be reported, not swallowed — a workflow step that silently
 * "succeeds" while sending nothing makes an entire campaign's attribution wrong
 * with no signal that anything is wrong.
 */

const CREDS: MetaCredentials = {
    pixelId: '111222333',
    accessToken: 'EAAG-test-token',
} as MetaCredentials

const originalFetch = globalThis.fetch

/** Capture the outgoing request instead of calling Meta. */
function stubFetch(response: { ok: boolean; status: number; body?: unknown }) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
        return {
            ok: response.ok,
            status: response.status,
            json: async () => response.body ?? {},
        }
    }) as never
    return calls
}

/** Extract the first event from the captured request body. */
function firstEvent(calls: Array<{ url: string; body: Record<string, unknown> }>): Record<string, unknown> {
    const data = calls[0].body.data as Array<Record<string, unknown>>
    return data[0]
}

beforeEach(() => {
    globalThis.fetch = originalFetch
})

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('sendConversionEvent — configuration guards', () => {
    it('refuses to send when the site has no Pixel configured', async () => {
        const calls = stubFetch({ ok: true, status: 200 })
        const result = await sendConversionEvent({ ...CREDS, pixelId: '' }, {
            eventName: 'Purchase',
        })
        assert.equal(result.ok, false)
        assert.match(result.error!, /Pixel not enabled/)
        assert.equal(calls.length, 0, 'nothing should be sent without a Pixel id')
    })

    it('refuses to send when the site has no access token', async () => {
        const calls = stubFetch({ ok: true, status: 200 })
        const result = await sendConversionEvent({ ...CREDS, accessToken: '' }, {
            eventName: 'Purchase',
        })
        assert.equal(result.ok, false)
        assert.match(result.error!, /access token/)
        assert.equal(calls.length, 0)
    })
})

describe('sendConversionEvent — what is sent to Meta', () => {
    it('posts to the Pixel-specific events endpoint', async () => {
        const calls = stubFetch({ ok: true, status: 200, body: { events_received: 1 } })
        await sendConversionEvent(CREDS, { eventName: 'Lead' })
        assert.match(calls[0].url, /graph\.facebook\.com\/v\d+\.\d+\/111222333\/events$/)
    })

    it('sends the access token in the body, never in the URL where it could be logged', async () => {
        const calls = stubFetch({ ok: true, status: 200 })
        await sendConversionEvent(CREDS, { eventName: 'Lead' })
        assert.ok(!calls[0].url.includes('EAAG-test-token'), 'the token must not appear in the URL')
        assert.equal(calls[0].body.access_token, 'EAAG-test-token')
    })

    it('sends hashed personal data only — never a raw email or phone number', async () => {
        // This is the single most important guarantee in this file. Sending raw
        // personal data to Meta would be a data-protection breach.
        const calls = stubFetch({ ok: true, status: 200 })
        const emailHash = 'a'.repeat(64)
        const phoneHash = 'b'.repeat(64)
        await sendConversionEvent(CREDS, {
            eventName: 'Purchase',
            userData: { emailHash, phoneHash },
        })
        const sent = JSON.stringify(calls[0].body)
        assert.ok(!sent.includes('@'), 'no email address should appear anywhere in the payload')
        assert.deepEqual((firstEvent(calls).user_data as Record<string, unknown[]>).em, [emailHash])
        assert.deepEqual((firstEvent(calls).user_data as Record<string, unknown[]>).ph, [phoneHash])
    })

    it('omits user_data entirely when there is no personal data to send', async () => {
        const calls = stubFetch({ ok: true, status: 200 })
        await sendConversionEvent(CREDS, { eventName: 'PageView' })
        assert.equal(firstEvent(calls).user_data, undefined)
    })

    it('defaults the event time to now and the source to website', async () => {
        const calls = stubFetch({ ok: true, status: 200 })
        const before = Math.floor(Date.now() / 1000)
        await sendConversionEvent(CREDS, { eventName: 'Lead' })
        const event = firstEvent(calls)
        assert.ok((event.event_time as number) >= before, 'event_time should be a current unix timestamp')
        assert.equal(event.action_source, 'website')
    })

    it('uses an explicit event time when the caller supplies one', async () => {
        const calls = stubFetch({ ok: true, status: 200 })
        await sendConversionEvent(CREDS, { eventName: 'Purchase', eventTime: 1700000000 })
        assert.equal(firstEvent(calls).event_time, 1700000000)
    })

    it('passes through the purchase value and currency', async () => {
        const calls = stubFetch({ ok: true, status: 200 })
        await sendConversionEvent(CREDS, {
            eventName: 'Purchase',
            customData: { value: 15000, currency: 'NGN' },
        })
        assert.deepEqual(firstEvent(calls).custom_data, { value: 15000, currency: 'NGN' })
    })

    it('includes the deduplication id when one is supplied', async () => {
        const calls = stubFetch({ ok: true, status: 200 })
        await sendConversionEvent(CREDS, { eventName: 'Purchase', eventId: 'order-42' })
        assert.equal(firstEvent(calls).event_id, 'order-42')
    })
})

describe('sendConversionEvent — failure handling', () => {
    it('reports a rejection from Meta with Meta’s own message', async () => {
        stubFetch({
            ok: false,
            status: 400,
            body: { error: { message: 'Invalid access token' } },
        })
        const result = await sendConversionEvent(CREDS, { eventName: 'Purchase' })
        assert.equal(result.ok, false)
        assert.equal(result.status, 400)
        assert.equal(result.error, 'Invalid access token')
    })

    it('reports a failure even when Meta returns no error message', async () => {
        stubFetch({ ok: false, status: 500, body: {} })
        const result = await sendConversionEvent(CREDS, { eventName: 'Purchase' })
        assert.equal(result.ok, false)
        assert.match(result.error!, /500/)
    })

    it('reports a network failure instead of throwing into the caller', async () => {
        // A workflow step must record this as a failed step, not crash the run.
        globalThis.fetch = (async () => {
            throw new Error('socket hang up')
        }) as never
        const result = await sendConversionEvent(CREDS, { eventName: 'Purchase' })
        assert.equal(result.ok, false)
        assert.equal(result.error, 'socket hang up')
    })

    it('reports success with the number of events Meta accepted', async () => {
        stubFetch({ ok: true, status: 200, body: { events_received: 1 } })
        const result = await sendConversionEvent(CREDS, { eventName: 'Purchase' })
        assert.equal(result.ok, true)
        assert.equal(result.eventsReceived, 1)
    })

    it('passes log messages to the supplied logger rather than the console', async () => {
        stubFetch({ ok: false, status: 400, body: { error: { message: 'nope' } } })
        const logged: Array<[string, string]> = []
        await sendConversionEvent(CREDS, { eventName: 'Purchase' }, (level, msg) => logged.push([level, msg]))
        assert.ok(logged.some(([level]) => level === 'warn'), 'a failure should be logged as a warning')
    })
})
