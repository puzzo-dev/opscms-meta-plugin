import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { getMaskedMetaAppId, getMetaAppCredentials, getMetaWebhookVerifyToken, setMetaAppProvider } from '../../src/utils/metaCrypto'

/** The platform's Meta app comes from the host's settings when the host gives it, and from the environment otherwise. */
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
    it('is nothing when neither the host nor the environment gives it', () => {
        assert.equal(getMetaAppCredentials(), null)
        assert.equal(getMetaWebhookVerifyToken(), undefined)
        assert.equal(getMaskedMetaAppId(), null)
    })

    it('comes from the host\'s settings, with no environment variable set', () => {
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

    it('prefers what the host gives, and falls back to the environment for what it leaves out', () => {
        process.env.META_APP_ID = 'env-id'
        process.env.META_APP_SECRET = 'env-secret'
        process.env.META_WEBHOOK_VERIFY_TOKEN = 'env-token'
        setMetaAppProvider(() => ({ appId: 'host-id', appSecret: '', webhookVerifyToken: null }))
        assert.deepEqual(getMetaAppCredentials(), { appId: 'host-id', appSecret: 'env-secret' })
        assert.equal(getMetaWebhookVerifyToken(), 'env-token')
        setMetaAppProvider(null)
        assert.deepEqual(getMetaAppCredentials(), { appId: 'env-id', appSecret: 'env-secret' }, 'a host that gives nothing works from the environment, as before')
    })

    it('treats a host that fails to answer as one that gave nothing', () => {
        process.env.META_APP_ID = 'env-id'
        process.env.META_APP_SECRET = 'env-secret'
        setMetaAppProvider(() => { throw new Error('not ready') })
        assert.deepEqual(getMetaAppCredentials(), { appId: 'env-id', appSecret: 'env-secret' })
    })

    it('needs both the id and the secret', () => {
        setMetaAppProvider(() => ({ appId: 'only-id' }))
        assert.equal(getMetaAppCredentials(), null)
    })
})
