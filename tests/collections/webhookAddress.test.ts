import assert from 'node:assert'
import { describe, it } from 'node:test'

import type { Field } from 'payload'

import { MetaConfig } from '../../src/collections/MetaConfig'

const find = (fields: Field[], name: string): Field | undefined => {
    for (const field of fields) {
        if ('name' in field && field.name === name) return field
        const inner = ('fields' in field && field.fields) || ('tabs' in field && field.tabs?.flatMap((tab) => tab.fields)) || []
        const hit = find(inner as Field[], name)
        if (hit) return hit
    }
    return undefined
}

describe('the Meta config shows the address Meta must call', () => {
    const field = find(MetaConfig.fields, 'webhookUrl') as unknown as { virtual: boolean; admin: { readOnly: boolean }; hooks: { afterRead: Array<() => string> } }

    it('has a read-only address that holds nothing', () => {
        assert.ok(field, 'the field is there')
        assert.strictEqual(field.virtual, true)
        assert.strictEqual(field.admin.readOnly, true)
    })

    it('is the plugin\'s webhook route on the server\'s own address, and empty when that is unknown', () => {
        process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.example.com/'
        assert.strictEqual(field.hooks.afterRead[0]!(), 'https://cms.example.com/api/meta-webhook')
        delete process.env.PAYLOAD_PUBLIC_SERVER_URL
        assert.strictEqual(field.hooks.afterRead[0]!(), '')
    })
})
