import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Payload } from 'payload'

import { registerNotificationChannel } from './registry'
import { toE164Digits } from './phone'
import { metaWhatsAppChannel } from './whatsapp'

const logger = { warn() {}, error() {}, info() {} }
const payload = { logger, find: async () => ({ docs: [], totalDocs: 0 }) } as unknown as Payload

afterEach(() => {
    delete process.env.META_PHONE_NUMBER_ID
    delete process.env.META_ACCESS_TOKEN
})

describe('registering with the host', () => {
    it('puts the provider where the host looks for it, and replaces it when registered again', () => {
        const key = Symbol.for('opscms.notificationChannelProviders')
        const holder = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>
        holder[key]?.clear()
        registerNotificationChannel(metaWhatsAppChannel)
        registerNotificationChannel(metaWhatsAppChannel)
        assert.equal(holder[key]?.size, 1)
        assert.equal(holder[key]?.get('meta-whatsapp'), metaWhatsAppChannel)
    })
})

describe('configuration', () => {
    it('has nothing to send from when the site did not connect an official number', async () => {
        assert.equal(await metaWhatsAppChannel.resolve({ payload, siteSlug: 'shop', settings: undefined, platformSettings: false }), null)
        assert.equal(await metaWhatsAppChannel.resolve({ payload, settings: undefined, platformSettings: false }), null)
    })

    it('uses the number a site connected, when official WhatsApp is on for it', async () => {
        const connected = {
            logger,
            find: async (args: { collection: string }) =>
                args.collection === 'sites'
                    ? { docs: [{ id: 7 }], totalDocs: 1 }
                    : { docs: [{ authMethod: 'oauth', whatsappPhoneNumberId: ' 1234 ', accessToken: 'plain-token' }], totalDocs: 1 },
        } as unknown as Payload
        const config = await metaWhatsAppChannel.resolve({ payload: connected, siteSlug: 'shop', settings: undefined, platformSettings: false })
        assert.deepEqual(config, { phoneNumberId: '1234', accessToken: 'plain-token', siteId: 7 })
    })

    it('ignores a masked token', async () => {
        const masked = {
            logger,
            find: async (args: { collection: string }) =>
                args.collection === 'sites'
                    ? { docs: [{ id: 7 }], totalDocs: 1 }
                    : { docs: [{ authMethod: 'oauth', whatsappPhoneNumberId: '1234', accessToken: '••••abcd' }], totalDocs: 1 },
        } as unknown as Payload
        assert.equal(await metaWhatsAppChannel.resolve({ payload: masked, siteSlug: 'shop', settings: undefined, platformSettings: false }), null)
    })

    it('reads the environment, only when both values are there', () => {
        assert.equal(metaWhatsAppChannel.resolveFromEnvironment?.(), null)
        process.env.META_PHONE_NUMBER_ID = '55'
        assert.equal(metaWhatsAppChannel.resolveFromEnvironment?.(), null)
        process.env.META_ACCESS_TOKEN = 'envtok'
        assert.deepEqual(metaWhatsAppChannel.resolveFromEnvironment?.(), { phoneNumberId: '55', accessToken: 'envtok' })
    })

    it('goes before another WhatsApp service when settings are read, and after it when the environment is read', () => {
        assert.equal(metaWhatsAppChannel.priority, 10)
        assert.equal(metaWhatsAppChannel.environmentPriority, 20)
    })
})

describe('sending', () => {
    const realFetch = globalThis.fetch
    let bodies: unknown[]
    let status: number
    let text: string

    beforeEach(() => {
        bodies = []
        status = 200
        text = '{}'
        globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)))
            return new Response(text, { status })
        }) as typeof fetch
    })
    afterEach(() => { globalThis.fetch = realFetch })

    const config = { phoneNumberId: '1234', accessToken: 'tok' }
    const send = (to: string, template?: { name: string; languageCode: string; bodyParameters: Array<{ name?: string; text: string }> }) =>
        metaWhatsAppChannel.send({ payload, config, to, message: 'free text', template, variables: {} })

    it('sends free text when the message has no approved template, expanding a local number', async () => {
        assert.deepEqual(await send('0803 123 4567'), { success: true })
        assert.deepEqual(bodies[0], { messaging_product: 'whatsapp', to: '2348031234567', type: 'text', text: { body: 'free text' } })
    })

    it('sends an approved template, by name, with the values the host gave it', async () => {
        assert.deepEqual(await send('2348031234567', { name: 'order_ready', languageCode: 'en', bodyParameters: [{ text: 'Ada' }, { text: 'QTN-1' }] }), { success: true })
        assert.deepEqual(bodies[0], {
            messaging_product: 'whatsapp',
            to: '2348031234567',
            type: 'template',
            template: { name: 'order_ready', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ada' }, { type: 'text', text: 'QTN-1' }] }] },
        })
    })

    it('holds a template message whose template is not approved yet', async () => {
        status = 400
        text = JSON.stringify({ error: { message: '(#132001) Template name does not exist in the translation' } })
        const outcome = await send('2348031234567', { name: 'order_ready', languageCode: 'en', bodyParameters: [{ text: 'Ada' }] })
        assert.equal(outcome.success, false)
        assert.equal(outcome.deferred, true)
        assert.match(outcome.error ?? '', /not approved by Meta yet/)
    })

    it('holds the message on a server error and gives up on a rejected one', async () => {
        status = 503
        assert.equal((await send('2348031234567')).deferred, true)
        status = 400
        text = JSON.stringify({ error: { message: 'bad' } })
        const outcome = await send('2348031234567')
        assert.equal(outcome.success, false)
        assert.equal(outcome.deferred, false)
    })

    it('fails without calling Meta when the number has no digits', async () => {
        assert.equal((await send('n/a')).success, false)
        assert.equal(bodies.length, 0)
    })
})

describe('phone numbers', () => {
    it('expands a local number and leaves a qualified one alone', () => {
        assert.equal(toE164Digits('0803 123 4567', '234'), '2348031234567')
        assert.equal(toE164Digits('+234 803 123 4567', '234'), '2348031234567')
        assert.equal(toE164Digits('00 44 20 7946 0958', '234'), '442079460958')
        assert.equal(toE164Digits('', '234'), '')
    })
})
