import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { META_OAUTH_MESSAGE_SOURCE, oauthPopupResponse } from '../../src/oauth/popupResult.js'

describe('oauthPopupResponse', () => {
    it('tells the opener the result and falls back to the admin document', async () => {
        const response = oauthPopupResponse({
            ok: true,
            error: null,
            nextUrl: 'http://localhost:3456/admin/collections/meta-config/4?meta_oauth_success=1',
        })
        const html = await response.text()
        assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
        assert.match(html, /postMessage/)
        assert.match(html, new RegExp(META_OAUTH_MESSAGE_SOURCE))
        assert.match(html, /window.opener/)
        assert.match(html, /meta_oauth_success=1/)
    })

    it('does not let an error string close the script tag', async () => {
        const response = oauthPopupResponse({
            ok: false,
            error: '</script><script>alert(1)</script>',
            nextUrl: 'http://localhost:3456/admin/collections/meta-config',
        })
        const html = await response.text()
        assert.equal(html.split('</script>').length - 1, 1)
        assert.equal(html.includes('<script>alert(1)'), false)
    })
})