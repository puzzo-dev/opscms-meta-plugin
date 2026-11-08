import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { explainTemplateSendError } from '../../src/whatsapp/templateErrors'

describe('explainTemplateSendError', () => {
    it('queues a send whose template is still with Meta, and hides the response body', () => {
        const explained = explainTemplateSendError('(#132001) Template name does not exist in the translation')
        assert.equal(explained?.retryable, true)
        assert.match(explained?.error ?? '', /not approved by Meta yet/)
        assert.equal(explained?.error.includes('132001'), false)
    })

    it('gives up on a template problem that waiting will not fix', () => {
        const explained = explainTemplateSendError('Template parameter count mismatch')
        assert.equal(explained?.retryable, false)
    })

    it('leaves unrelated send failures to the caller', () => {
        assert.equal(explainTemplateSendError('Invalid OAuth access token'), null)
    })
})
