import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
    catalogSourceSlug,
    COMMERCE_COLLECTION,
    deleteRequest,
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
