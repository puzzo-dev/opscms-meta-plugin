/**
 * Maps a commerce document onto a Meta catalog product.
 * Commerce sites store sellable items in `catalogue-items` (the commerce
 * plugin). The same shape is what the public CSV feed emits, so a product
 * Meta pulls from the feed and a product this plugin pushes on save agree.
 */

export const COMMERCE_COLLECTION = 'catalogue-items'

export interface CatalogItemData {
    id: string
    title: string
    description: string
    availability: 'in stock' | 'out of stock'
    condition: 'new'
    price: string
    link: string
    image_link?: string
    brand?: string
}

export interface CatalogBatchRequest {
    method: 'UPDATE' | 'DELETE'
    data: CatalogItemData | { id: string }
}

function firstDefined<T>(...values: (T | undefined | null)[]): T | undefined {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return value
    }
    return undefined
}

export function plainText(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        for (const entry of Object.values(record)) {
            if (typeof entry === 'string' && entry.trim()) return entry
        }
    }
    return ''
}

function stripHtml(input: string): string {
    return input.replace(/<[^>]+>/g, '').trim()
}

export function resolveImageUrl(media: unknown, serverUrl: string): string {
    if (!media) return ''
    if (typeof media === 'string') {
        if (media.startsWith('http://') || media.startsWith('https://')) return media
        return `${serverUrl}/api/media/serve/${encodeURIComponent(media)}`
    }
    if (typeof media === 'object') {
        const record = media as Record<string, unknown>
        const url = typeof record.url === 'string' ? record.url : ''
        if (url) return url.startsWith('http') ? url : `${serverUrl}${url}`
        const filename = typeof record.filename === 'string' ? record.filename : ''
        if (filename) return `${serverUrl}/api/media/serve/${encodeURIComponent(filename)}`
    }
    return ''
}

export function relationId(value: unknown): string | number | undefined {
    if (typeof value === 'string' || typeof value === 'number') return value
    if (value && typeof value === 'object' && 'id' in value) {
        const id = (value as { id?: unknown }).id
        if (typeof id === 'string' || typeof id === 'number') return id
    }
    return undefined
}

/**
 * The collection a site's catalog actually reads. An empty setting means the
 * commerce catalogue, which is what a newly connected shop is syncing.
 */
export function catalogSourceSlug(configured: unknown): string {
    const slug = typeof configured === 'string' ? configured.trim() : ''
    return slug || COMMERCE_COLLECTION
}

/** What an item page address template may contain: `{slug}` (the item's own slug, else its number) and `{category.slug}` (the slug of the item's category: a shop whose pages are one per category, and whose items are sizes of it). */
export const URL_TEMPLATE_PLACEHOLDERS = ['{slug}', '{category.slug}'] as const

/** Whether a template has something to substitute (an address with neither would give every item the same link). */
export function hasUrlPlaceholder(template: string): boolean {
    return URL_TEMPLATE_PLACEHOLDERS.some((placeholder) => template.includes(placeholder))
}

/**
 * The page address of one item, from the site's template. `{category.slug}` needs the item's category read as a document (depth 1) with a slug; an item whose category
 * has none (or has no category) has no address and is left out, rather than being given one that leads nowhere.
 */
export function itemLink(doc: Record<string, unknown>, template: string): string | null {
    let link = template.trim()
    if (!hasUrlPlaceholder(link)) return null
    if (link.includes('{category.slug}')) {
        const category = doc.category
        const categorySlug = category && typeof category === 'object' ? plainText((category as Record<string, unknown>).slug).trim() : ''
        if (!categorySlug) return null
        link = link.split('{category.slug}').join(encodeURIComponent(categorySlug))
    }
    if (link.includes('{slug}')) link = link.split('{slug}').join(encodeURIComponent(plainText(firstDefined(doc.slug, doc.id))))
    return link
}

export function toCatalogItem(
    doc: Record<string, unknown>,
    options: { urlTemplate: string; serverUrl: string; currency?: string; brand?: string },
): CatalogItemData | null {
    const title = plainText(firstDefined(doc.title, doc.name, doc.heading)).trim()
    const price = firstDefined(doc.price, doc.price_from, doc.priceFrom)
    if (!title || price === undefined || price === null || price === '') return null
    const amount = Number(price)
    if (!Number.isFinite(amount)) return null

    const link = itemLink(doc, options.urlTemplate)
    if (!link) return null

    const rawDescription = firstDefined(doc.description, doc.excerpt, doc.body)
    const description = rawDescription ? stripHtml(plainText(rawDescription)).slice(0, 5000) : title
    const available = doc.available === undefined ? true : Boolean(doc.available)
    const currency = (options.currency || 'NGN').toUpperCase()
    const image = resolveImageUrl(firstDefined(doc.image, doc.featuredImage, doc.photo), options.serverUrl)

    const item: CatalogItemData = {
        id: String(doc.id),
        title,
        description,
        availability: available ? 'in stock' : 'out of stock',
        condition: 'new',
        price: `${amount.toFixed(2)} ${currency}`,
        link,
    }
    if (image) item.image_link = image
    if (options.brand) item.brand = options.brand
    return item
}

export function updateRequest(item: CatalogItemData): CatalogBatchRequest {
    return { method: 'UPDATE', data: item }
}

export function deleteRequest(retailerId: string): CatalogBatchRequest {
    return { method: 'DELETE', data: { id: retailerId } }
}
