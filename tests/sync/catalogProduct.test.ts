import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
    catalogSourceSlug,
    COMMERCE_COLLECTION,
    deleteRequest,
    hasUrlPlaceholder,
    itemLink,
    toCatalogItem,
} from '../../src/sync/catalogProduct.js'

const template = 'https://shop.example/menu/{slug}'

describe('toCatalogItem', () => {
    it('maps a commerce catalogue item the way the Facebook shop expects', () => {
        const item = toCatalogItem({
            id: 12,
            title: 'Ofada rice',
            slug: 'ofada-rice',
            description: '<p>With ayamase</p>',
            price: 4500,
            available: true,
            image: { url: 'https://cdn.example/ofada.jpg' },
        }, { urlTemplate: template, serverUrl: 'https://cms.example', brand: 'That Ofada Girl' })

        assert.deepEqual(item, {
            id: '12',
            title: 'Ofada rice',
            description: 'With ayamase',
            availability: 'in stock',
            condition: 'new',
            price: '4500.00 NGN',
            link: 'https://shop.example/menu/ofada-rice',
            image_link: 'https://cdn.example/ofada.jpg',
            brand: 'That Ofada Girl',
        })
    })

    it('skips an item Meta would reject for having no price', () => {
        assert.equal(toCatalogItem({ id: 1, title: 'No price' }, { urlTemplate: template, serverUrl: '' }), null)
    })

    it('skips an item when the shop has no {slug} link template', () => {
        assert.equal(toCatalogItem(
            { id: 1, title: 'Rice', price: 10 },
            { urlTemplate: 'https://shop.example/menu', serverUrl: '' },
        ), null)
    })

    it('reads a localized title', () => {
        const item = toCatalogItem(
            { id: 3, name: { en: 'Growth plan' }, slug: 'growth', price: 20 },
            { urlTemplate: template, serverUrl: '' },
        )
        assert.equal(item?.title, 'Growth plan')
    })

    it('marks an unavailable item out of stock', () => {
        const item = toCatalogItem(
            { id: 4, title: 'Sold out', slug: 'sold-out', price: 1, available: false },
            { urlTemplate: template, serverUrl: '' },
        )
        assert.equal(item?.availability, 'out of stock')
    })
})

describe('catalog source', () => {
    it('uses the commerce catalogue when a site has not named another collection', () => {
        assert.equal(catalogSourceSlug(undefined), COMMERCE_COLLECTION)
        assert.equal(catalogSourceSlug('  '), COMMERCE_COLLECTION)
        assert.equal(catalogSourceSlug('products'), 'products')
    })

    it('deletes by the same retailer id the update used', () => {
        assert.deepEqual(deleteRequest('12'), { method: 'DELETE', data: { id: '12' } })
    })
})

describe('the page address of an item', () => {
    const flavour = { id: 3, title: 'Berry Cherry 330ml', price: 2500, category: { id: 9, slug: 'berry-cherry' } }
    const adun = 'https://avrilbeetails.com/adun/{category.slug}'

    it('can be the slug of its category, for a shop with one page per category', () => {
        assert.equal(itemLink(flavour, adun), 'https://avrilbeetails.com/adun/berry-cherry')
        assert.equal(toCatalogItem(flavour, { urlTemplate: adun, serverUrl: '' })?.link, 'https://avrilbeetails.com/adun/berry-cherry')
    })

    it('leaves out an item whose category cannot be read or has no slug (a link that leads nowhere is worse than none)', () => {
        assert.equal(itemLink({ id: 3, title: 'x', category: 9 }, adun), null, 'the category was not read as a document')
        assert.equal(itemLink({ id: 3, title: 'x', category: { id: 9 } }, adun), null)
        assert.equal(itemLink({ id: 3, title: 'x' }, adun), null)
        assert.equal(toCatalogItem({ id: 3, title: 'x', price: 1 }, { urlTemplate: adun, serverUrl: '' }), null)
    })

    it('still takes {slug}, and both together', () => {
        assert.equal(itemLink({ id: 7, slug: 'jollof' }, 'https://s.example/m/{slug}'), 'https://s.example/m/jollof')
        assert.equal(itemLink({ id: 7 }, 'https://s.example/m/{slug}'), 'https://s.example/m/7', 'the number when there is no slug, as before')
        assert.equal(itemLink({ id: 7, slug: 'a', category: { slug: 'b c' } }, 'https://s.example/{category.slug}/{slug}'), 'https://s.example/b%20c/a')
    })

    it('needs something to substitute, so every item does not get the same link', () => {
        assert.equal(hasUrlPlaceholder('https://s.example/menu'), false)
        assert.equal(itemLink({ id: 1, slug: 'a' }, 'https://s.example/menu'), null)
    })
})

describe('an item as a save hands it over', () => {
    it('has its category read when the template needs the category\'s slug, and not otherwise', async () => {
        const { withCategoryRead } = await import('../../src/sync/catalogSync.js')
        const reads: Array<unknown> = []
        const payload = { findByID: async ({ id }: { id: unknown }) => { reads.push(id); return { id, slug: 'berry-cherry' } } } as never
        const read = await withCategoryRead(payload, { id: 3, category: 9 }, 'https://avrilbeetails.com/adun/{category.slug}')
        assert.deepEqual((read as { category: unknown }).category, { id: 9, slug: 'berry-cherry' })
        assert.deepEqual(reads, [9])
        assert.deepEqual(await withCategoryRead(payload, { id: 3, category: 9 }, 'https://s.example/{slug}'), { id: 3, category: 9 })
        assert.deepEqual(reads, [9], 'no read for a template that does not need it')
        const failing = { findByID: async () => { throw new Error('gone') } } as never
        assert.deepEqual(await withCategoryRead(failing, { id: 3, category: 9 }, 'https://s.example/{category.slug}'), { id: 3, category: 9 })
    })
})
