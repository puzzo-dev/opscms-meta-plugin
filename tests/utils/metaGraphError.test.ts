import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { explainGraphError } from '../../src/utils/metaGraphClient.js'

describe('what a failed call to Meta says', () => {
    it('says what to do when the business has not accepted the Pixel terms', () => {
        const said = explainGraphError({ error: { message: 'Application does not have permission for this action', code: 10, error_subcode: 1784018, error_user_title: 'Business has not accepted Pixel Terms of Service', error_user_msg: 'Business has not accepted Pixel Terms of Service.' } })
        assert.match(said ?? '', /Events Manager/)
        assert.match(said ?? '', /accept the terms/)
    })

    it('uses the message Meta gives for a person when there is one, and its technical message otherwise', () => {
        assert.equal(explainGraphError({ error: { message: 'technical', error_user_title: 'Title', error_user_msg: 'Plain words.' } }), 'Title: Plain words.')
        assert.equal(explainGraphError({ error: { message: 'Invalid OAuth access token.' } }), 'Invalid OAuth access token.')
        assert.equal(explainGraphError({}), null)
        assert.equal(explainGraphError(null), null)
    })
})
