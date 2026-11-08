import type { Access, PayloadRequest, CollectionSlug } from 'payload'
import { timingSafeEqual } from 'node:crypto'

/**
 * Minimal access control helpers used by the plugin. Mirrors
 * opscms-erpnext-plugin/src/types.ts's shape exactly — this plugin is a
 * separate published npm package (not workspace-linked, same reason
 * opscms-erpnext-plugin isn't: workspace links broke the production
 * pipeline build), so it can't import that package's internals and needs
 * its own copy of these primitives.
 */

export type UserWithRole = {
    id: string | number
    role: 'super-admin' | 'admin' | 'editor' | string
    email?: string
    organization?: string | number | { id: string | number } | null
    site?: string | number | { id: string | number } | null
}

export const anyone: Access = () => true

export const authenticated: Access = ({ req: { user } }) => Boolean(user)

export const superAdminOnly: Access = ({ req: { user } }) => {
    if (!user) return false
    return getUserWithRole(user)?.role === 'super-admin'
}

export function isInternalAuth(req: { headers?: { get: (name: string) => string | null } } | PayloadRequest): boolean {
    const secret = process.env.INTERNAL_API_SECRET
    if (!secret) return false
    const authSecret = req.headers?.get('x-internal-auth')
    if (!authSecret) return false
    const a = Buffer.from(authSecret)
    const b = Buffer.from(secret)
    if (a.byteLength !== b.byteLength) return false
    return timingSafeEqual(a, b)
}

export const getUserOrgId = (user: UserWithRole): string | number | null => {
    if (!user.organization) return null
    if (typeof user.organization === 'object') return user.organization.id
    return user.organization
}

export const getUserSiteId = (user: UserWithRole): string | number | null => {
    if (!user.site) return null
    if (typeof user.site === 'object') return user.site.id
    return user.site
}

/**
 * Used by every OAuth endpoint that loads a config by client-supplied
 * configId (metaOAuth.ts, threadsOAuth.ts). A role check alone
 * (isAdminOrAbove) is not enough — it never verifies the caller's own
 * site/org actually matches the target config's tenant, which would let an
 * admin for Tenant A pass Tenant B's configId and hijack Tenant B's Meta
 * connection. Centralized here (rather than copied per-endpoint-file) so
 * the fix can't drift out of sync between the Meta and Threads OAuth flows
 * the way the underlying tenant-pinning gap itself did across collections.
 * super-admin bypasses this check (matches every other access-control
 * helper in the platform).
 */
export function callerOwnsConfigSite(req: { user?: unknown }, config: Record<string, unknown>): boolean {
    const user = getUserWithRole(req.user)
    if (!user) return false
    if (user.role === 'super-admin') return true
    const configSite = typeof config.site === 'object' && config.site !== null
        ? (config.site as Record<string, unknown>).id
        : config.site
    const configOrg = typeof config.organization === 'object' && config.organization !== null
        ? (config.organization as Record<string, unknown>).id
        : config.organization
    const callerSiteId = getUserSiteId(user)
    const callerOrgId = getUserOrgId(user)
    const siteMatches = callerSiteId != null && configSite != null && String(configSite) === String(callerSiteId)
    const orgMatches = callerOrgId != null && configOrg != null && String(configOrg) === String(callerOrgId)
    return siteMatches || orgMatches
}

/** Resolved Meta API credentials for a single site, decrypted and ready to use. appId/appSecret are deployment-wide (META_APP_ID/META_APP_SECRET, see utils/metaCrypto.ts), not part of a site's credentials. */
export interface MetaCredentials {
    accessToken: string
    businessManagerId?: string
    pixelId?: string
    catalogId?: string
    whatsappPhoneNumberId?: string
    whatsappBusinessAccountId?: string
}

export interface MetaConfigDoc {
    id: string | number
    label: string
    site: string | number | { id: string | number }
    isActive: boolean
    connectionStatus?: 'connected' | 'disconnected' | 'untested'
    authMethod?: 'manual' | 'oauth'
    accessToken?: string
    businessManagerId?: string
    oauthUserAccessToken?: string
    facebookPageId?: string
    facebookPageName?: string
    instagramBusinessAccountId?: string
    instagramUsername?: string
    pixelEnabled?: boolean
    pixelId?: string
    catalogEnabled?: boolean
    catalogId?: string
    catalogSourceCollection?: string
    catalogItemUrlTemplate?: string
    whatsappEnabled?: boolean
    whatsappPhoneNumberId?: string
    whatsappBusinessAccountId?: string
    threadsEnabled?: boolean
    threadsUserId?: string
    threadsUsername?: string
    threadsAccessToken?: string
}

/** Structured logger signature used across the plugin. */
export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void

/**
 * Runtime collection slugs that may not yet be in the host CMS's generated
 * payload-types.ts. Cast through this when referencing collections that
 * aren't in Config['collections'] yet.
 */
export type RuntimeCollectionSlug =
    | 'users'
    | 'sites'
    | 'organizations'
    | 'meta-config'

/**
 * Safely extract a UserWithRole from an unknown request user.
 * Payload's `req.user` is typed as the host's User which doesn't include
 * `role`/`organization`/`site` — this helper reads those fields via bracket
 * notation with runtime checks instead of `as unknown as UserWithRole`.
 */
export function getUserWithRole(user: unknown): UserWithRole | undefined {
    if (!user || typeof user !== 'object') return undefined
    const obj = user as Record<string, unknown>
    if (typeof obj.role !== 'string') return undefined
    return {
        id: obj.id as string | number,
        role: obj.role,
        email: typeof obj.email === 'string' ? obj.email : undefined,
        organization: obj.organization as UserWithRole['organization'],
        site: obj.site as UserWithRole['site'],
    }
}

/**
 * Cast a string to the host's CollectionSlug type.
 * Plugin collections (like 'meta-config') or dynamically-configured collection
 * names may not be in the host's generated payload-types.ts. Centralized here
 * so the cast only appears in one place — every call site uses this helper
 * instead of scattering `as unknown as CollectionSlug` across the codebase.
 */
export function asCollectionSlug(slug: string): CollectionSlug {
    return slug as CollectionSlug
}
