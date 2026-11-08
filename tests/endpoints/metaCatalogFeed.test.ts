import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PayloadRequest } from 'payload'

import { metaCatalogFeedEndpoint } from '../../src/endpoints/metaCatalogFeed.js'

/**
 * The catalog feed publishes a site's products to Meta as a CSV that Meta
 * fetches and ingests into a Commerce Catalog.
 *
 * Two things must hold. The feed must contain only the requested site's products
 * — a leak here would publish one tenant's catalogue under another tenant's shop.
 * And the CSV must survive product titles containing commas, quotes and
 * newlines, because a broken row silently corrupts every product after it in the
 * file.
 */

const SITE = { id: 7, slug: 'thatofadagirl' }

type FindArgs = { collection: string; where?: Record<string, unknown> }

function makeReq(opts: {
    site?: string
    config?: Record<string, unknown> | null
    items?: Array<Record<string, unknown>>
    siteFound?: boolean
}) {
    const calls: FindArgs[] = []
    return {
        calls,
        req: {
            query: opts.site === undefined ? {} : { site: opts.site },
            payload: {
                find: async (args: FindArgs) => {
                    calls.push(args)
                    if (args.collection === 'sites') {
                        return opts.siteFound === false
                            ? { totalDocs: 0, docs: [] }
                            : { totalDocs: 1, docs: [SITE] }
                    }
                    if (args.collection === 'meta-config') {
                        return opts.config
                            ? { totalDocs: 1, docs: [opts.config] }
                            : { totalDocs: 0, docs: [] }
                    }
                    return { totalDocs: (opts.items ?? []).length, docs: opts.items ?? [] }
                },
                logger: { error: () => {}, warn: () => {}, info: () => {} },
            },
        },
    }
}

const CONFIG = {
    catalogSourceCollection: 'catalogue-items',
    catalogItemUrlTemplate: 'https://thatofadagirl.com/menu/{slug}',
}

const run = (r: unknown) =>
    metaCatalogFeedEndpoint.handler(r as PayloadRequest)

async function csvOf(items: Array<Record<string, unknown>>) {
    const { req } = makeReq({ site: SITE.slug, config: CONFIG, items })
    const res = await run(req)
    return (await res.text()).split('\n')
}

describe('metaCatalogFeed — request validation', () => {
    it('requires a site parameter', async () => {
        const { req } = makeReq({})
        const res = await run(req)
        assert.equal(res.status, 400)
    })

    it('returns 404 for a site that does not exist', async () => {
        const { req } = makeReq({ site: 'nope', siteFound: false })
        assert.equal((await run(req)).status, 404)
    })

    it('returns 404 when the site has not switched the catalog on', async () => {
        const { req } = makeReq({ site: SITE.slug, config: null })
        assert.equal((await run(req)).status, 404)
    })

    it('reports a missing source collection as a configuration error', async () => {
        const { req } = makeReq({ site: SITE.slug, config: { catalogItemUrlTemplate: 'x/{slug}' } })
        assert.equal((await run(req)).status, 400)
    })

    it('reports a missing URL template as a configuration error', async () => {
        const { req } = makeReq({ site: SITE.slug, config: { catalogSourceCollection: 'catalogue-items' } })
        assert.equal((await run(req)).status, 400)
    })
})

describe('metaCatalogFeed — tenant isolation', () => {
    it('queries products for the requested site only', async () => {
        const { req, calls } = makeReq({ site: SITE.slug, config: CONFIG, items: [] })
        await run(req)
        const productQuery = calls.find((c) => c.collection === 'catalogue-items')
        assert.deepEqual(productQuery?.where, { site: { equals: SITE.id } })
    })

    it('looks up the Meta config for that site only, and only when active', async () => {
        const { req, calls } = makeReq({ site: SITE.slug, config: CONFIG, items: [] })
        await run(req)
        const configQuery = calls.find((c) => c.collection === 'meta-config')
        assert.deepEqual(configQuery?.where, {
            site: { equals: SITE.id },
            isActive: { equals: true },
            catalogEnabled: { equals: true },
        })
    })
})

describe('metaCatalogFeed — CSV output', () => {
    it('is served as CSV so Meta can ingest it directly', async () => {
        const { req } = makeReq({ site: SITE.slug, config: CONFIG, items: [] })
        const res = await run(req)
        assert.match(res.headers.get('content-type')!, /text\/csv/)
    })

    it('starts with the header row Meta expects', async () => {
        const rows = await csvOf([])
        assert.equal(rows[0], 'id,title,description,availability,condition,price,link,image_link')
    })

    it('emits one row per complete product', async () => {
        const rows = await csvOf([
            { id: 1, title: 'Jollof Rice', price: 5000, slug: 'jollof' },
            { id: 2, title: 'Suya', price: 3000, slug: 'suya' },
        ])
        assert.equal(rows.length, 3, 'header plus two products')
    })

    it('quotes a title containing a comma so the row does not split', async () => {
        // Without this, "Rice, Chicken and Plantain" would shift every later
        // column by one and corrupt the product in Meta's catalogue.
        const rows = await csvOf([{ id: 1, title: 'Rice, Chicken and Plantain', price: 5000, slug: 'combo' }])
        assert.ok(rows[1].includes('"Rice, Chicken and Plantain"'))
    })

    it('escapes an embedded double quote by doubling it', async () => {
        const rows = await csvOf([{ id: 1, title: 'The "Big" Plate', price: 5000, slug: 'big' }])
        assert.ok(rows[1].includes('"The ""Big"" Plate"'))
    })

    it('quotes a description containing a newline', async () => {
        const rows = await csvOf([
            { id: 1, title: 'Jollof', description: 'Line one\nLine two', price: 5000, slug: 'j' },
        ])
        assert.ok(rows.join('\n').includes('"Line one\nLine two"'))
    })

    it('strips HTML out of a rich-text description', async () => {
        const rows = await csvOf([
            { id: 1, title: 'Jollof', description: '<p>Smoky <strong>party</strong> rice</p>', price: 5000, slug: 'j' },
        ])
        assert.ok(rows[1].includes('Smoky party rice'))
        assert.ok(!rows[1].includes('<p>'))
    })

    it('formats the price with two decimals and a currency', async () => {
        const rows = await csvOf([{ id: 1, title: 'Jollof', price: 5000, slug: 'j' }])
        assert.ok(rows[1].includes('5000.00 NGN'))
    })

    it('marks an unavailable product as out of stock', async () => {
        const rows = await csvOf([{ id: 1, title: 'Jollof', price: 5000, slug: 'j', available: false }])
        assert.ok(rows[1].includes('out of stock'))
    })

    it('treats a product with no availability flag as in stock', async () => {
        const rows = await csvOf([{ id: 1, title: 'Jollof', price: 5000, slug: 'j' }])
        assert.ok(rows[1].includes('in stock'))
    })

    it('builds the product link from the configured template', async () => {
        const rows = await csvOf([{ id: 1, title: 'Jollof', price: 5000, slug: 'jollof-rice' }])
        assert.ok(rows[1].includes('https://thatofadagirl.com/menu/jollof-rice'))
    })

    it('skips a product with no title rather than emitting an invalid row', async () => {
        const rows = await csvOf([
            { id: 1, price: 5000, slug: 'no-title' },
            { id: 2, title: 'Suya', price: 3000, slug: 'suya' },
        ])
        assert.equal(rows.length, 2, 'header plus the one valid product')
    })

    it('skips a product with no price', async () => {
        const rows = await csvOf([
            { id: 1, title: 'Unpriced', slug: 'x' },
            { id: 2, title: 'Suya', price: 3000, slug: 'suya' },
        ])
        assert.equal(rows.length, 2)
        assert.ok(rows[1].includes('Suya'))
    })

    it('falls back through the alternative title and price field names', async () => {
        // Collections differ across sites: some use `name`, some `title`; some
        // `price`, some `price_from`.
        const rows = await csvOf([{ id: 1, name: 'Fashion Piece', price_from: 25000, slug: 'fp' }])
        assert.ok(rows[1].includes('Fashion Piece'))
        assert.ok(rows[1].includes('25000.00 NGN'))
    })
})
