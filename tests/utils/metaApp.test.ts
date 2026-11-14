import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { getMaskedMetaAppId, getMetaAppCredentials, getMetaWebhookVerifyToken, setMetaAppProvider } from '../../src/utils/metaCrypto'

/** The platform's Meta app comes from the host's settings, and from nowhere else. */
const NAMES = ['META_APP_ID', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
    for (const name of NAMES) { saved[name] = process.env[name]; delete process.env[name] }
    setMetaAppProvider(null)
})
afterEach(() => {
    for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] }
    setMetaAppProvider(null)
})

describe('the platform\'s Meta app', () => {
    it('is nothing when the host gives none', () => {
        assert.equal(getMetaAppCredentials(), null)
        assert.equal(getMetaWebhookVerifyToken(), undefined)
        assert.equal(getMaskedMetaAppId(), null)
    })

    it('comes from the host\'s settings', () => {
        setMetaAppProvider(() => ({ appId: ' 123456789 ', appSecret: 'shh', webhookVerifyToken: 'tok' }))
        assert.deepEqual(getMetaAppCredentials(), { appId: '123456789', appSecret: 'shh' })
        assert.equal(getMetaWebhookVerifyToken(), 'tok')
        assert.equal(getMaskedMetaAppId(), '••••6789')
    })

    it('is read again each time, so a change in the host\'s settings is used at once', () => {
        let current = { appId: 'one', appSecret: 's1' }
        setMetaAppProvider(() => current)
        assert.equal(getMetaAppCredentials()?.appId, 'one')
        current = { appId: 'two', appSecret: 's2' }
        assert.equal(getMetaAppCredentials()?.appId, 'two')
    })

    it('is never read from the environment, with or without a host', () => {
        process.env.META_APP_ID = 'env-id'
        process.env.META_APP_SECRET = 'env-secret'
        process.env.META_WEBHOOK_VERIFY_TOKEN = 'env-token'
        assert.equal(getMetaAppCredentials(), null)
        assert.equal(getMetaWebhookVerifyToken(), undefined)
        setMetaAppProvider(() => ({ appId: 'host-id', appSecret: '', webhookVerifyToken: null }))
        assert.equal(getMetaAppCredentials(), null, 'the host\'s missing secret is not filled in from the environment')
        assert.equal(getMetaWebhookVerifyToken(), undefined)
    })

    it('treats a host that fails to answer as one that gave nothing', () => {
        setMetaAppProvider(() => { throw new Error('not ready') })
        assert.equal(getMetaAppCredentials(), null)
    })

    it('needs both the id and the secret', () => {
        setMetaAppProvider(() => ({ appId: 'only-id' }))
        assert.equal(getMetaAppCredentials(), null)
    })
})
