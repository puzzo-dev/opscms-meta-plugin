import type { Access } from 'payload'
import { asCollectionSlug, getUserOrgId, getUserSiteId, getUserWithRole, isInternalAuth } from '../types'

/**
 * Tenant scope for this plugin. Mirrors payload-cms/src/access/roles.ts.
 *
 * An organization admin is the site owner. Their account has no single site,
 * so they manage Meta for every site in their organization. An editor stays
 * pinned to one site. Anyone else with no site is denied.
 */

type SiteLookup = {
    payload?: {
        find: (args: {
            collection: ReturnType<typeof asCollectionSlug>
            where: { organization: { equals: string | number } }
            limit: number
            pagination: boolean
            depth: number
            select: { id: true }
            overrideAccess: boolean
        }) => Promise<{ docs: Array<{ id: string | number }> }>
    }
}

/**
 * Per request, per organization: the PROMISE of the ids, so the several rules of one request (this package has a dozen collections, each
 * asking for the same answer at the same moment) share one query instead of each sending its own. And only the ids are asked for: a
 * site row is large (every menu, footer column and translation comes with it), and reading whole rows to keep only the id made a page
 * load for an admin run a dozen of the heaviest queries there are, enough to time the database out.
 */
const orgSiteIdsCache = new WeakMap<object, Map<string, Promise<(string | number)[]>>>()

async function getOrgSiteIds(req: SiteLookup, orgId: string | number): Promise<(string | number)[]> {
    let byOrg = orgSiteIdsCache.get(req)
    if (!byOrg) {
        byOrg = new Map()
        orgSiteIdsCache.set(req, byOrg)
    }
    const key = String(orgId)
    const cached = byOrg.get(key)
    if (cached) return cached
    const payload = req.payload
    if (!payload) return []
    const pending = payload
        .find({
            collection: asCollectionSlug('sites'),
            where: { organization: { equals: orgId } },
            limit: 0,
            pagination: false,
            depth: 0,
            select: { id: true },
            overrideAccess: true,
        })
        .then((res) => res.docs.map((doc) => doc.id))
    byOrg.set(key, pending)
    // A failed lookup is not kept: the next rule of the request asks afresh.
    pending.catch(() => byOrg.delete(key))
    return pending
}

async function orgScopeFor(req: SiteLookup, orgId: string | number, siteField: string) {
    const siteIds = await getOrgSiteIds(req, orgId)
    if (siteIds.length === 0) return false
    return { [siteField]: { in: siteIds } }
}

function submittedSiteId(data: Record<string, unknown> | undefined, siteField: string): unknown {
    if (!data) return undefined
    const raw = data[siteField]
    if (raw && typeof raw === 'object') return (raw as { id?: string | number }).id
    return raw
}

/**
 * Whether this user may act on `siteId` from an endpoint that loads the row
 * with overrideAccess. Super-admin, the editor's one site, or any site owned
 * by an organization admin's organization.
 */
export async function userMayAccessSite(
    req: SiteLookup & { user?: unknown },
    siteId: string | number | null | undefined,
): Promise<boolean> {
    if (siteId === null || siteId === undefined || siteId === '') return false
    const u = getUserWithRole(req.user)
    if (!u) return false
    if (u.role === 'super-admin') return true
    const ownSite = getUserSiteId(u)
    if (ownSite != null) return String(ownSite) === String(siteId)
    if (u.role !== 'admin') return false
    const orgId = getUserOrgId(u)
    if (orgId == null) return false
    const siteIds = await getOrgSiteIds(req, orgId)
    return siteIds.some((id) => String(id) === String(siteId))
}

function ownerScope(req: { user?: unknown } & SiteLookup, siteField: string) {
    const u = getUserWithRole(req.user)
    if (!u) return false
    const siteId = getUserSiteId(u)
    if (siteId) return { [siteField]: { equals: siteId } }
    if (u.role === 'admin') {
        const orgId = getUserOrgId(u)
        if (orgId) return orgScopeFor(req, orgId, siteField)
    }
    return false
}

export const siteScopedRead = (siteField = 'site'): Access => {
    return ({ req }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = getUserWithRole(req.user)
        if (!u) return false
        if (u.role === 'super-admin') return true
        return ownerScope(req, siteField)
    }
}

export const siteScopedCreate = (siteField = 'site'): Access => {
    return ({ req, data }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = getUserWithRole(req.user)
        if (!u) return false
        if (u.role === 'super-admin') return true
        if (!['admin', 'editor'].includes(u.role)) return false
        const rawDocSite = submittedSiteId(data as Record<string, unknown> | undefined, siteField)
        if (rawDocSite === undefined || rawDocSite === null || rawDocSite === '') return false
        const siteId = getUserSiteId(u)
        if (siteId) return String(rawDocSite) === String(siteId)
        if (u.role !== 'admin') return false
        const orgId = getUserOrgId(u)
        if (orgId == null) return false
        return getOrgSiteIds(req, orgId).then((ids) => ids.some((id) => String(id) === String(rawDocSite)))
    }
}

export const siteScopedUpdate = (siteField = 'site'): Access => {
    return ({ req }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = getUserWithRole(req.user)
        if (!u) return false
        if (u.role === 'super-admin') return true
        return ownerScope(req, siteField)
    }
}

export const siteScopedDelete = (siteField = 'site'): Access => {
    return ({ req }) => {
        if (isInternalAuth(req)) return true
        if (!req.user) return false
        const u = getUserWithRole(req.user)
        if (!u) return false
        if (u.role === 'super-admin') return true
        if (u.role === 'admin') return ownerScope(req, siteField)
        return false
    }
}
