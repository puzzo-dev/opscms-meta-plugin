import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { contentHash, metaTemplateName, toMetaBody, valueAtPath } from '../../src/templates/body'

describe('toMetaBody', () => {
    it('renames the user\'s placeholders to names Meta accepts and remembers where each came from', () => {
        const result = toMetaBody('Hi {{doc.values.first_name}}, we have your enquiry and will call you on {{doc.values.phone}} soon.')
        assert.equal(result.ok, true)
        if (!result.ok) return
        assert.equal(result.body.text, 'Hi {{doc_values_first_name}}, we have your enquiry and will call you on {{doc_values_phone}} soon.')
        assert.deepEqual(result.body.parameters.map((p) => [p.name, p.path]), [
            ['doc_values_first_name', 'doc.values.first_name'],
            ['doc_values_phone', 'doc.values.phone'],
        ])
        assert.ok(result.body.parameters.every((p) => p.example.length > 0))
    })

    it('uses one name for a variable that appears twice', () => {
        const result = toMetaBody('Hi {{name}}, thank you for choosing us, {{name}}, we will be in touch very soon.')
        assert.equal(result.ok, true)
        if (result.ok) assert.equal(result.body.parameters.length, 1)
    })

    it('gives a name that starts with a letter, and keeps names apart', () => {
        const result = toMetaBody('Order {{1}} for {{order.ref}} and {{order_ref}} has been received by our team today.')
        assert.equal(result.ok, true)
        if (!result.ok) return
        const names = result.body.parameters.map((p) => p.name)
        assert.ok(names.every((n) => /^[a-z][a-z0-9_]*$/.test(n)))
        assert.equal(new Set(names).size, names.length)
    })

    it('explains in plain words what Meta would refuse', () => {
        const startsWith = toMetaBody('{{name}}, your order has been received by us today.')
        assert.equal(startsWith.ok, false)
        if (!startsWith.ok) assert.match(startsWith.problems.join(' '), /cannot start with a variable/)

        const endsWith = toMetaBody('Your order has been received, reference {{ref}}')
        assert.equal(endsWith.ok, false)
        if (!endsWith.ok) assert.match(endsWith.problems.join(' '), /cannot end with a variable/)

        const adjacent = toMetaBody('Hello {{first}} {{last}} your order has been received.')
        assert.equal(adjacent.ok, false)
        if (!adjacent.ok) assert.match(adjacent.problems.join(' '), /next to each other/)

        const crowded = toMetaBody('Hi {{a}} and {{b}} then {{c}} ok.')
        assert.equal(crowded.ok, false)
        if (!crowded.ok) assert.match(crowded.problems.join(' '), /too many variables/)

        assert.equal(toMetaBody('   ').ok, false)
        assert.equal(toMetaBody(`Hello ${'x'.repeat(1100)} end.`).ok, false)
        assert.equal(toMetaBody('Hello 😀😀😀😀😀😀😀 thank you for your order today.').ok, false)
    })

    it('collapses extra blank lines instead of refusing them', () => {
        const result = toMetaBody('Hello there, thank you.\n\n\n\nWe will be in touch.')
        assert.equal(result.ok, true)
        if (result.ok) assert.equal(result.body.text, 'Hello there, thank you.\n\nWe will be in touch.')
    })

    it('accepts a message with no variables', () => {
        const result = toMetaBody('Thank you for your enquiry. We will contact you shortly.')
        assert.equal(result.ok, true)
        if (result.ok) assert.deepEqual(result.body.parameters, [])
    })
})

describe('names and fingerprints', () => {
    it('changes with the wording and not with line endings', () => {
        assert.notEqual(contentHash('Hello'), contentHash('Hello!'))
        assert.equal(contentHash('a\r\nb'), contentHash('a\nb'))
    })

    it('makes a name Meta accepts, unique per site, key and wording', () => {
        const name = metaTemplateName(7, 'Booking Received — Customer', 'abcdef123456')
        assert.match(name, /^[a-z0-9_]+$/)
        assert.notEqual(name, metaTemplateName(8, 'Booking Received — Customer', 'abcdef123456'))
        assert.notEqual(name, metaTemplateName(7, 'Booking Received — Customer', 'ffffff123456'))
    })
})

describe('valueAtPath', () => {
    const data = { doc: { values: { first_name: 'Ada', note: 'line one\nline two', list: ['x', 'y'] } }, n: 5 }
    it('reads a nested value as one clean line', () => {
        assert.equal(valueAtPath(data, 'doc.values.first_name'), 'Ada')
        assert.equal(valueAtPath(data, 'doc.values.note'), 'line one line two')
        assert.equal(valueAtPath(data, 'n'), '5')
        assert.equal(valueAtPath(data, 'doc.values.list[1]'), 'y')
    })
    it('gives an empty value for anything missing or not plain', () => {
        assert.equal(valueAtPath(data, 'doc.nope.x'), '')
        assert.equal(valueAtPath(data, 'doc.values'), '')
    })
})
