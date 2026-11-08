import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clearedMetaUserConnection } from './clearedConnection.js'

describe('clearedMetaUserConnection', () => {
    it('drops every token and Meta id the Facebook login stored', () => {
        const cleared = clearedMetaUserConnection()
        for (const key of [
            'accessToken',
            'oauthUserAccessToken',
            'oauthExpiresAt',
            'facebookPageId',
            'facebookPageName',
            'instagramBusinessAccountId',
            'instagramUsername',
            'businessManagerId',
            'pixelId',
            'catalogId',
            'whatsappPhoneNumberId',
            'whatsappBusinessAccountId',
        ]) {
            assert.equal(cleared[key], null, key)
        }
        assert.equal(cleared.pixelEnabled, false)
        assert.equal(cleared.catalogEnabled, false)
        assert.equal(cleared.whatsappEnabled, false)
        assert.equal(cleared.authMethod, 'manual')
        assert.equal(cleared.connectionStatus, 'disconnected')
    })

    it('does not touch the site row or the shop URL template', () => {
        const cleared = clearedMetaUserConnection()
        assert.equal('site' in cleared, false)
        assert.equal('label' in cleared, false)
        assert.equal('catalogItemUrlTemplate' in cleared, false)
        assert.equal('catalogSourceCollection' in cleared, false)
        assert.equal('threadsAccessToken' in cleared, false)
    })
})
