import type { Endpoint, PayloadRequest } from 'payload'
import { decryptCredential } from './metaCrypto'
import { asCollectionSlug, type MetaCredentials } from '../types'

/**
 * Resolve a site's active Meta credentials from the meta-config collection.
 * Mirrors opscms-erpnext-plugin's getCredentials() exactly: per-site lookup
 * (never falls back to another site's config — that would leak data across
 * tenants), decrypts the masking-safety-net way (re-decrypt if an "enc:"
 * prefix leaked through afterRead), fails closed on any inconsistency.
 */
export async function getMetaCredentials(
    payload: Parameters<Endpoint['handler']>[0]['payload'],
    siteSlug?: string | null,
    _req?: PayloadRequest,
): Promise<MetaCredentials | null> {
    const isMasked = (v: string) => v.includes('•')

    const buildCreds = (cfg: Record<string, unknown>): MetaCredentials | null => {
        const rawToken = cfg.accessToken as string
        if (!rawToken) return null

        // Meta's long-lived Page tokens have no refresh_token grant — past
        // oauthExpiresAt (~60 days from Connect, tracked since this fix) the
        // token is dead. Previously nothing ever checked this: API calls
        // would just start failing with an upstream OAuthException while
        // connectionStatus kept showing "Connected" indefinitely (the only
        // other code that re-tests it, testMetaConnection, explicitly skips
        // re-testing once already connected). Fail closed here and mark the
        // config disconnected so the failure is visible in the admin UI.
        const expiresAt = cfg.oauthExpiresAt as string | undefined
        if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
            payload.logger.warn(`[MetaCredentials] accessToken expired for config ${cfg.id} — marking disconnected.`)
            payload.update({
                collection: asCollectionSlug('meta-config'),
                id: cfg.id as string | number,
                data: { connectionStatus: 'disconnected' },
                overrideAccess: true,
                context: { skipConnectionTest: true },
            }).catch((err) => payload.logger.warn(`[MetaCredentials] Failed to mark config ${cfg.id} disconnected: ${err}`))
            return null
        }

        if (isMasked(rawToken)) {
            payload.logger.error(
                `[MetaCredentials] Credential masking leaked through for config ${cfg.id}. ` +
                `This indicates a Payload framework bug. Failing closed — do NOT fall back to raw SQL.`,
            )
            return null
        }

        const accessToken = rawToken.startsWith('enc:') ? decryptCredential(rawToken) : rawToken
        if (!accessToken || isMasked(accessToken)) return null

        return {
            accessToken,
            businessManagerId: (cfg.businessManagerId as string) || undefined,
            pixelId: (cfg.pixelEnabled && cfg.pixelId) ? (cfg.pixelId as string) : undefined,
            catalogId: (cfg.catalogEnabled && cfg.catalogId) ? (cfg.catalogId as string) : undefined,
            whatsappPhoneNumberId: (cfg.whatsappEnabled && cfg.whatsappPhoneNumberId) ? (cfg.whatsappPhoneNumberId as string) : undefined,
            whatsappBusinessAccountId: (cfg.whatsappEnabled && cfg.whatsappBusinessAccountId) ? (cfg.whatsappBusinessAccountId as string) : undefined,
        }
    }

    if (!siteSlug) return null

    const sites = await payload.find({
        collection: 'sites',
        where: { slug: { equals: siteSlug } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
    })
    if (sites.totalDocs === 0) return null

    const configs = await payload.find({
        collection: asCollectionSlug('meta-config'),
        where: { site: { equals: sites.docs[0].id }, isActive: { equals: true } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true },
    })
    if (configs.totalDocs === 0) return null

    return buildCreds(configs.docs[0] as Record<string, unknown>)
}
