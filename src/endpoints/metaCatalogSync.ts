import type { Endpoint } from 'payload'
import { decryptCredential } from '../utils/metaCrypto'
import { graphGet, graphPost } from '../utils/metaGraphClient'
import { callerOwnsConfigSite, asCollectionSlug, getUserWithRole } from '../types'
import { catalogSourceSlug, relationId } from '../sync/catalogProduct'
import { findCatalogConfig, syncCatalogCollection, tokenForCatalog } from '../sync/catalogSync'
import { listBusinesses } from '../utils/metaBusinesses'

function isAdminOrAbove(req: { user?: unknown }): boolean {
    const role = getUserWithRole(req.user)?.role
    return role === 'super-admin' || role === 'admin' || role === 'editor'
}

async function loadConfig(req: Parameters<Endpoint['handler']>[0], configId: string) {
    return (await req.payload.findByID({
        collection: asCollectionSlug('meta-config'),
        id: configId,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true },
    })) as Record<string, unknown>
}

function userToken(config: Record<string, unknown>): string {
    const raw = tokenForCatalog(config)
    return raw
}

// ── GET /meta-oauth/me?configId= ────────────────────────────────────────────
// The Facebook account that connected this site. Each site keeps the login of
// the person who clicked Connect, so one operator's Facebook is never used
// for another site.
export const metaOAuthMeEndpoint: Endpoint = {
    path: '/meta-oauth/me',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })
        const config = await loadConfig(req, configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const raw = config.oauthUserAccessToken
        if (typeof raw !== 'string' || !raw) {
            return Response.json({ connected: false })
        }
        const token = raw.startsWith('enc:') ? decryptCredential(raw) : raw
        const me = await graphGet<{ id?: string; name?: string }>('/me', {
            fields: 'id,name',
            access_token: token,
        })
        if (!me.ok) return Response.json({ connected: true, error: me.error }, { status: 502 })
        return Response.json({ connected: true, id: me.data?.id, name: me.data?.name })
    },
}

// ── GET /meta-catalog/catalogs?configId= ────────────────────────────────────
export const metaCatalogListEndpoint: Endpoint = {
    path: '/meta-catalog/catalogs',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })
        const config = await loadConfig(req, configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const token = userToken(config)
        if (!token) return Response.json({ error: 'Connect this site with Facebook before choosing a catalog.' }, { status: 400 })

        const businesses = await listBusinesses(token, config.businessManagerId)
        if (!businesses.ok) return Response.json({ error: businesses.error }, { status: 502 })

        const catalogs: Array<{ id: string; name: string; businessId: string; businessName: string }> = []
        for (const business of businesses.businesses) {
            const owned = await graphGet<{ data?: Array<{ id: string; name?: string }> }>(
                `/${business.id}/owned_product_catalogs`,
                { fields: 'id,name', access_token: token, limit: '50' },
            )
            if (!owned.ok) continue
            for (const catalog of owned.data?.data ?? []) {
                catalogs.push({
                    id: catalog.id,
                    name: catalog.name || catalog.id,
                    businessId: business.id,
                    businessName: business.name || business.id,
                })
            }
        }
        return Response.json({ catalogs, businesses: businesses.businesses })
    },
}

// ── POST /meta-catalog/create { configId, name, businessId } ────────────────
export const metaCatalogCreateEndpoint: Endpoint = {
    path: '/meta-catalog/create',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const body = (await req.json?.()) as { configId?: string; name?: string; businessId?: string } | undefined
        const name = body?.name?.trim()
        if (!body?.configId || !name) return Response.json({ error: 'Missing configId or name' }, { status: 400 })
        const config = await loadConfig(req, body.configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const token = userToken(config)
        if (!token) return Response.json({ error: 'Connect this site with Facebook before creating a catalog.' }, { status: 400 })

        const businesses = await listBusinesses(token, body.businessId || config.businessManagerId)
        if (!businesses.ok) return Response.json({ error: businesses.error }, { status: 502 })
        const business = businesses.businesses.find((item) => item.id === body.businessId) || businesses.businesses[0]
        if (!business) return Response.json({ error: 'This Facebook login has no Business Manager to own a catalog.' }, { status: 400 })

        const created = await graphPost<{ id?: string }>(`/${business.id}/owned_product_catalogs`, {
            name,
            access_token: token,
        })
        if (!created.ok || !created.data?.id) {
            return Response.json({ error: created.error || 'Catalog creation failed' }, { status: 502 })
        }

        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: body.configId,
            data: {
                catalogEnabled: true,
                catalogId: created.data.id,
                catalogSourceCollection: catalogSourceSlug(config.catalogSourceCollection),
                businessManagerId: business.id,
            },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })
        return Response.json({ ok: true, catalogId: created.data.id, businessId: business.id, name })
    },
}

// ── POST /meta-catalog/select { configId, catalogId, businessId } ───────────
export const metaCatalogSelectEndpoint: Endpoint = {
    path: '/meta-catalog/select',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const body = (await req.json?.()) as { configId?: string; catalogId?: string; businessId?: string } | undefined
        if (!body?.configId || !body.catalogId) {
            return Response.json({ error: 'Missing configId or catalogId' }, { status: 400 })
        }
        const config = await loadConfig(req, body.configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: body.configId,
            data: {
                catalogEnabled: true,
                catalogId: body.catalogId,
                catalogSourceCollection: catalogSourceSlug(config.catalogSourceCollection),
                ...(body.businessId ? { businessManagerId: body.businessId } : {}),
            },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })
        const sourceCollection = catalogSourceSlug(config.catalogSourceCollection)
        return Response.json({ ok: true, catalogId: body.catalogId, sourceCollection })
    },
}

// ── POST /meta-catalog/sync { configId } ────────────────────────────────────
export const metaCatalogSyncEndpoint: Endpoint = {
    path: '/meta-catalog/sync',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const body = (await req.json?.()) as { configId?: string } | undefined
        if (!body?.configId) return Response.json({ error: 'Missing configId' }, { status: 400 })
        const config = await loadConfig(req, body.configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        if (!config.catalogEnabled) {
            return Response.json({ error: 'Turn on Commerce Catalog and choose a catalog first.' }, { status: 400 })
        }
        if (!config.catalogItemUrlTemplate) {
            return Response.json({ error: 'Set the item page URL template (it must contain {slug} or {category.slug}) before syncing.' }, { status: 400 })
        }
        const siteId = relationId(config.site)
        if (siteId == null) return Response.json({ error: 'This Meta connection has no site.' }, { status: 400 })
        const ready = await findCatalogConfig(req.payload, siteId)
        if (!ready) {
            return Response.json({ error: 'Connect with Facebook and choose a catalog before syncing products.' }, { status: 400 })
        }
        const result = await syncCatalogCollection(req.payload, ready, siteId)
        return Response.json(result)
    },
}
