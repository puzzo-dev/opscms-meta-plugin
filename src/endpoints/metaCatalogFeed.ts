import type { Endpoint } from 'payload'
import { itemLink } from '../sync/catalogProduct'
import { asCollectionSlug } from '../types'

/**
 * Public, site-scoped Commerce Catalog feed for Facebook/Instagram Shop.
 * Meta's Commerce Manager fetches this URL on a schedule — no auth, same
 * pattern as other public CMS content-delivery endpoints.
 *
 * GET /api/meta-catalog/feed?site=<slug>
 *
 * Generic by design: reads whichever collection the site's meta-config
 * designates (catalogSourceCollection) rather than assuming any one site's
 * schema, tolerating a few common field-name variations (title/name,
 * price/price_from, image/featuredImage, description/excerpt).
 */

function csvEscape(value: unknown): string {
    const str = value === null || value === undefined ? '' : String(value)
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
    }
    return str
}

function firstDefined<T>(...values: (T | undefined | null)[]): T | undefined {
    for (const v of values) {
        if (v !== undefined && v !== null && v !== '') return v
    }
    return undefined
}

function stripHtml(input: string): string {
    return input.replace(/<[^>]+>/g, '').trim()
}

function resolveImageUrl(media: unknown, serverUrl: string): string {
    if (!media) return ''
    if (typeof media === 'string') {
        // Already a URL or bare filename.
        if (media.startsWith('http://') || media.startsWith('https://')) return media
        return `${serverUrl}/api/media/serve/${encodeURIComponent(media)}`
    }
    if (typeof media === 'object') {
        const m = media as Record<string, unknown>
        const url = (m.url as string) || undefined
        if (url) return url.startsWith('http') ? url : `${serverUrl}${url}`
        const filename = (m.filename as string) || undefined
        if (filename) return `${serverUrl}/api/media/serve/${encodeURIComponent(filename)}`
    }
    return ''
}

export const metaCatalogFeedEndpoint: Endpoint = {
    path: '/meta-catalog/feed',
    method: 'get',
    handler: async (req) => {
        const siteSlug = req.query?.site as string | undefined
        if (!siteSlug) {
            return Response.json({ error: 'Missing required query param: site' }, { status: 400 })
        }

        const sites = await req.payload.find({
            collection: 'sites',
            where: { slug: { equals: siteSlug } },
            limit: 1,
            depth: 0,
            overrideAccess: true,
        })
        if (sites.totalDocs === 0) {
            return Response.json({ error: 'Site not found' }, { status: 404 })
        }
        const siteId = sites.docs[0].id

        const configs = await req.payload.find({
            collection: asCollectionSlug('meta-config'),
            where: { site: { equals: siteId }, isActive: { equals: true }, catalogEnabled: { equals: true } },
            limit: 1,
            depth: 0,
            overrideAccess: true,
        })
        if (configs.totalDocs === 0) {
            return Response.json({ error: 'Commerce Catalog not enabled for this site' }, { status: 404 })
        }
        const config = configs.docs[0] as Record<string, unknown>
        const sourceCollection = config.catalogSourceCollection as string | undefined
        const urlTemplate = config.catalogItemUrlTemplate as string | undefined
        if (!sourceCollection) {
            return Response.json({ error: 'catalogSourceCollection not configured for this site' }, { status: 400 })
        }
        if (!urlTemplate) {
            return Response.json({ error: 'catalogItemUrlTemplate not configured for this site' }, { status: 400 })
        }

        const serverUrl = (process.env.PAYLOAD_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')

        let items: Array<Record<string, unknown>>
        try {
            const result = await req.payload.find({
                collection: asCollectionSlug(sourceCollection),
                where: { site: { equals: siteId } },
                limit: 1000,
                depth: 1,
                overrideAccess: true,
            })
            items = result.docs as Array<Record<string, unknown>>
        } catch (err) {
            req.payload.logger.error(`[MetaCatalogFeed] Failed to query collection "${sourceCollection}": ${err}`)
            return Response.json({ error: `Failed to query collection "${sourceCollection}"` }, { status: 500 })
        }

        const header = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link']
        const rows: string[] = [header.join(',')]

        for (const item of items) {
            const id = String(item.id)
            const title = String(firstDefined(item.title, item.name, item.heading) ?? '')
            const rawDescription = firstDefined(item.description, item.excerpt, item.body)
            const description = rawDescription ? stripHtml(String(rawDescription)).slice(0, 5000) : ''
            const price = firstDefined(item.price, item.price_from, item.priceFrom)
            const available = item.available === undefined ? true : Boolean(item.available)
            const link = itemLink(item, urlTemplate)
            const image = firstDefined(item.image, item.featuredImage, item.photo)
            const imageLink = resolveImageUrl(image, serverUrl)

            if (!title || price === undefined || !link) continue // Meta requires all three — skip incomplete items rather than emit an invalid row.

            rows.push([
                csvEscape(id),
                csvEscape(title),
                csvEscape(description),
                csvEscape(available ? 'in stock' : 'out of stock'),
                csvEscape('new'),
                csvEscape(`${Number(price).toFixed(2)} NGN`),
                csvEscape(link),
                csvEscape(imageLink),
            ].join(','))
        }

        return new Response(rows.join('\n'), {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Cache-Control': 'public, max-age=3600',
            },
        })
    },
}
