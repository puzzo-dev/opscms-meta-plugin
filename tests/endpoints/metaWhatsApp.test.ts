import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { phonesFromWaba } from '../../src/endpoints/metaWhatsApp.js'

describe('phonesFromWaba', () => {
    it('keeps the business account with each phone the login can send from', () => {
        const numbers = phonesFromWaba(
            { id: 'waba-1', name: 'I-Varse' },
            [{ id: 'phone-9', display_phone_number: '+234 800 000 0000', verified_name: 'I-Varse' }],
        )
        assert.deepEqual(numbers, [{
            id: 'phone-9',
            displayPhone: '+234 800 000 0000',
            verifiedName: 'I-Varse',
            wabaId: 'waba-1',
            wabaName: 'I-Varse',
        }])
    })

    it('skips a phone row that has no id', () => {
        assert.deepEqual(phonesFromWaba({ id: 'waba-1' }, [{ display_phone_number: '+1' }]), [])
    })
})
