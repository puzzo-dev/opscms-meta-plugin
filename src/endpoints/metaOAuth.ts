import type { Endpoint } from 'payload'
import { encryptCredential, decryptCredential, signOAuthState, verifyOAuthState, getMetaAppCredentials, getMaskedMetaAppId } from '../utils/metaCrypto'
import { graphGet, graphPost, GRAPH_API_VERSION } from '../utils/metaGraphClient'
import { callerOwnsConfigSite, getUserWithRole, asCollectionSlug } from '../types'
import { clearedMetaUserConnection } from '../oauth/clearedConnection'
import { oauthPopupResponse } from '../oauth/popupResult'
import { tokenForCatalog } from '../sync/catalogSync'
import { listBusinesses } from '../utils/metaBusinesses'
import { unsubscribeWabaFromApp } from '../utils/wabaSubscription'

/**
 * Meta Business Login connect flow — same idea as the official "Meta for
 * WordPress" plugin's connector: pick a Facebook Page you manage, auto-detect
 * its linked Instagram Business account, then select or create a Pixel.
 *
 * Scopes requested: business_management, pages_show_list, pages_read_engagement,
 * pages_manage_metadata, instagram_basic, ads_management, catalog_management,
 * whatsapp_business_management, whatsapp_business_messaging. Trim this list if a deployment's Meta App
 * review doesn't cover all of them — Meta will simply omit ungranted
 * permissions from the resulting token rather than failing the whole flow.
 *
 * IMPORTANT: these endpoints implement Meta's documented Graph API contracts
 * (OAuth dialog, token exchange, /me/accounts, owned_pixels, adspixels) as of
 * API version v21.0, but have not been exercised against a real Meta App —
 * doing so requires a live App ID/Secret and a browser to complete the OAuth
 * consent screen, neither of which exist in this environment. Do a manual
 * test connect before relying on this in production, and check Meta's current
 * API version if anything here returns a deprecation error.
 */

const OAUTH_SCOPES = [
    'business_management',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'instagram_basic',
    'ads_management',
    'catalog_management',
    'whatsapp_business_management',
    'whatsapp_business_messaging',
].join(',')

function isAdminOrAbove(req: { user?: unknown }): boolean {
    const role = getUserWithRole(req.user)?.role
    return role === 'super-admin' || role === 'admin' || role === 'editor'
}

function oauthFinished(args: { ok: boolean; error?: string; configId?: string }): Response {
    const adminBase = `${serverUrl()}/admin/collections/meta-config`
    const nextPath = args.configId ? `${adminBase}/${args.configId}` : adminBase
    const params = new URLSearchParams()
    if (args.ok) params.set('meta_oauth_success', '1')
    if (args.error) params.set('meta_oauth_error', args.error)
    const nextUrl = params.size ? `${nextPath}?${params}` : nextPath
    return oauthPopupResponse({ ok: args.ok, error: args.error ?? null, nextUrl })
}

function serverUrl(): string {
    return (process.env.PAYLOAD_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')
}

function callbackRedirectUri(): string {
    return `${serverUrl()}/api/meta-oauth/callback`
}

async function loadConfig(payload: Parameters<Endpoint['handler']>[0]['payload'], configId: string) {
    return (await payload.findByID({
        collection: asCollectionSlug('meta-config'),
        id: configId,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true },
    })) as Record<string, unknown>
}

// ── GET /meta-oauth/app-info ────────────────────────────────────────────────
// Tells the admin UI whether the platform-level Meta App (META_APP_ID/
// META_APP_SECRET) is configured, and a masked App ID to display — never the
// secret. No configId needed: this is deployment-wide, not per-site.
export const metaOAuthAppInfoEndpoint: Endpoint = {
    path: '/meta-oauth/app-info',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const creds = getMetaAppCredentials()
        return Response.json({ configured: Boolean(creds), maskedAppId: getMaskedMetaAppId() })
    },
}

// ── GET /meta-oauth/start?configId=<id> ────────────────────────────────────
export const metaOAuthStartEndpoint: Endpoint = {
    path: '/meta-oauth/start',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })

        let config: Record<string, unknown>
        try {
            config = await loadConfig(req.payload, configId)
        } catch {
            return Response.json({ error: 'Config not found' }, { status: 404 })
        }

        if (!callerOwnsConfigSite(req, config)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
        }

        const appCreds = getMetaAppCredentials()
        if (!appCreds) {
            return Response.json({ error: 'Meta App not configured on this deployment — set META_APP_ID and META_APP_SECRET.' }, { status: 400 })
        }

        const state = signOAuthState(configId)
        const params = new URLSearchParams({
            client_id: appCreds.appId,
            redirect_uri: callbackRedirectUri(),
            state,
            scope: OAUTH_SCOPES,
            response_type: 'code',
        })
        if (req.query?.popup === '1') params.set('display', 'popup')

        return Response.redirect(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?${params}`, 302)
    },
}

// ── GET /meta-oauth/callback?code=&state= ──────────────────────────────────
export const metaOAuthCallbackEndpoint: Endpoint = {
    path: '/meta-oauth/callback',
    method: 'get',
    handler: async (req) => {
        const code = req.query?.code as string | undefined
        const state = req.query?.state as string | undefined
        const oauthError = req.query?.error_description as string | undefined

        if (oauthError) {
            return oauthFinished({ ok: false, error: oauthError })
        }
        if (!code || !state) {
            return oauthFinished({ ok: false, error: 'Missing code or state' })
        }

        const configId = verifyOAuthState(state)
        if (!configId) {
            return oauthFinished({ ok: false, error: 'Invalid or expired connect request — try again' })
        }

        try {
            await loadConfig(req.payload, configId)
        } catch {
            return oauthFinished({ ok: false, error: 'Config not found' })
        }

        const appCreds = getMetaAppCredentials()
        if (!appCreds) {
            return oauthFinished({ ok: false, configId, error: 'Meta App not configured on this deployment — set META_APP_ID and META_APP_SECRET.' })
        }

        // Step 1: code -> short-lived user access token
        const shortLived = await graphGet<{ access_token?: string }>('/oauth/access_token', {
            client_id: appCreds.appId,
            client_secret: appCreds.appSecret,
            redirect_uri: callbackRedirectUri(),
            code,
        })
        if (!shortLived.ok || !shortLived.data?.access_token) {
            return oauthFinished({ ok: false, configId, error: shortLived.error || 'Token exchange failed' })
        }

        // Step 2: short-lived -> long-lived user access token (~60 days, refreshed on next connect)
        const longLived = await graphGet<{ access_token?: string }>('/oauth/access_token', {
            grant_type: 'fb_exchange_token',
            client_id: appCreds.appId,
            client_secret: appCreds.appSecret,
            fb_exchange_token: shortLived.data.access_token,
        })
        if (!longLived.ok || !longLived.data?.access_token) {
            return oauthFinished({ ok: false, configId, error: longLived.error || 'Long-lived token exchange failed' })
        }

        // connectionStatus intentionally NOT set to 'connected' here — that
        // conflates "the OAuth handshake with Meta succeeded" with "this
        // site has a working Page/Pixel connection". accessToken (the field
        // getMetaCredentials()/sendConversionEvent()/the Catalog feed
        // actually read) has no value yet at this point — it's only set
        // once a Page is chosen, in metaOAuthSelectPageEndpoint below. Until
        // then this collection-list status field should not claim the
        // config is usable.
        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: configId,
            data: {
                authMethod: 'oauth',
                oauthUserAccessToken: encryptCredential(longLived.data.access_token),
            },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        return oauthFinished({ ok: true, configId })
    },
}

// ── POST /meta-oauth/disconnect { configId } ────────────────────────────────
export const metaOAuthDisconnectEndpoint: Endpoint = {
    path: '/meta-oauth/disconnect',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const body = (await req.json?.()) as { configId?: string } | undefined
        const configId = body?.configId
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })

        let config: Record<string, unknown>
        try {
            config = await loadConfig(req.payload, configId)
        } catch {
            return Response.json({ error: 'Config not found' }, { status: 404 })
        }
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        // Stop Meta sending this business account's events here before the token that authorises it is cleared. Best effort: a
        // failure must not stop the owner disconnecting.
        const wabaId = typeof config.whatsappBusinessAccountId === 'string' ? config.whatsappBusinessAccountId : ''
        const token = tokenForCatalog(config)
        if (wabaId && token) {
            const removed = await unsubscribeWabaFromApp(token, wabaId)
            if (!removed.ok) req.payload.logger.warn(`[meta:oauth] could not unsubscribe ${wabaId} on disconnect: ${removed.error}`)
        }

        const cleared = clearedMetaUserConnection()
        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: configId,
            data: cleared,
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })
        return Response.json({ ok: true, ...cleared })
    },
}

// ── GET /meta-oauth/pages?configId=<id> ─────────────────────────────────────
export const metaOAuthPagesEndpoint: Endpoint = {
    path: '/meta-oauth/pages',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })

        const config = await loadConfig(req.payload, configId)
        if (!callerOwnsConfigSite(req, config)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
        }
        const rawToken = config.oauthUserAccessToken as string | undefined
        if (!rawToken) return Response.json({ error: 'Not connected — click "Connect to Meta Business" first' }, { status: 400 })
        const userToken = rawToken.startsWith('enc:') ? decryptCredential(rawToken) : rawToken

        const result = await graphGet<{ data?: Array<{ id: string; name: string }> }>('/me/accounts', {
            fields: 'id,name',
            access_token: userToken,
            limit: '100',
        })
        if (!result.ok) return Response.json({ error: result.error }, { status: 502 })

        return Response.json({ pages: result.data?.data ?? [] })
    },
}

// ── POST /meta-oauth/select-page { configId, pageId } ───────────────────────
export const metaOAuthSelectPageEndpoint: Endpoint = {
    path: '/meta-oauth/select-page',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const body = (await req.json?.()) as { configId?: string; pageId?: string } | undefined
        const configId = body?.configId
        const pageId = body?.pageId
        if (!configId || !pageId) return Response.json({ error: 'Missing configId or pageId' }, { status: 400 })

        const config = await loadConfig(req.payload, configId)
        if (!callerOwnsConfigSite(req, config)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
        }
        const rawToken = config.oauthUserAccessToken as string | undefined
        if (!rawToken) return Response.json({ error: 'Not connected — click "Connect to Meta Business" first' }, { status: 400 })
        const userToken = rawToken.startsWith('enc:') ? decryptCredential(rawToken) : rawToken

        // Re-fetch fresh from Graph rather than trusting a client-supplied page token —
        // the browser only ever sees page IDs/names, never page tokens.
        const pagesResult = await graphGet<{ data?: Array<{ id: string; name: string; access_token?: string }> }>('/me/accounts', {
            fields: 'id,name,access_token',
            access_token: userToken,
            limit: '100',
        })
        if (!pagesResult.ok) return Response.json({ error: pagesResult.error }, { status: 502 })

        const page = (pagesResult.data?.data ?? []).find((p) => p.id === pageId)
        if (!page || !page.access_token) {
            return Response.json({ error: 'Page not found or not accessible with the current connection' }, { status: 404 })
        }

        const igResult = await graphGet<{ instagram_business_account?: { id: string; username?: string } }>(`/${pageId}`, {
            fields: 'instagram_business_account{id,username}',
            access_token: page.access_token,
        })
        const igAccount = igResult.ok ? igResult.data?.instagram_business_account : undefined

        // Page access tokens derived from a long-lived user token inherit
        // that ~60-day lifetime, but /me/accounts doesn't return its own
        // expires_in — there is no refresh_token grant on Graph API, only
        // re-exchanging a still-valid long-lived token for a new one before
        // this window closes. Track the estimate so getMetaCredentials()
        // can fail closed (and mark disconnected) instead of silently
        // sending API calls with a dead token indefinitely.
        const oauthExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()

        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: configId,
            data: {
                facebookPageId: page.id,
                facebookPageName: page.name,
                accessToken: encryptCredential(page.access_token),
                instagramBusinessAccountId: igAccount?.id || null,
                instagramUsername: igAccount?.username || null,
                oauthExpiresAt,
                // accessToken is populated now — this is the point the
                // connection is genuinely usable, not the earlier OAuth
                // handshake step (see the comment in the callback endpoint).
                connectionStatus: 'connected',
            },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        return Response.json({
            ok: true,
            facebookPageId: page.id,
            facebookPageName: page.name,
            instagramBusinessAccountId: igAccount?.id || null,
            instagramUsername: igAccount?.username || null,
        })
    },
}

// ── GET /meta-oauth/pixels?configId=<id> ────────────────────────────────────
export const metaOAuthListPixelsEndpoint: Endpoint = {
    path: '/meta-oauth/pixels',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })

        const config = await loadConfig(req.payload, configId)
        if (!callerOwnsConfigSite(req, config)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
        }
        const token = tokenForCatalog(config)
        if (!token) return Response.json({ error: 'Not connected' }, { status: 400 })
        const businesses = await listBusinesses(token, config.businessManagerId)
        if (!businesses.ok) return Response.json({ error: businesses.error }, { status: 502 })

        const pixels: Array<{ id: string; name: string; businessId: string }> = []
        for (const business of businesses.businesses) {
            const result = await graphGet<{ data?: Array<{ id: string; name?: string }> }>(`/${business.id}/owned_pixels`, {
                fields: 'id,name',
                access_token: token,
                limit: '100',
            })
            if (!result.ok) continue
            for (const pixel of result.data?.data ?? []) {
                pixels.push({ id: pixel.id, name: pixel.name || pixel.id, businessId: business.id })
            }
        }
        return Response.json({ pixels, businesses: businesses.businesses })
    },
}

// ── POST /meta-oauth/select-pixel { configId, pixelId } ─────────────────────
export const metaOAuthSelectPixelEndpoint: Endpoint = {
    path: '/meta-oauth/select-pixel',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const body = (await req.json?.()) as { configId?: string; pixelId?: string } | undefined
        if (!body?.configId || !body.pixelId) {
            return Response.json({ error: 'Missing configId or pixelId' }, { status: 400 })
        }
        const config = await loadConfig(req.payload, body.configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const token = tokenForCatalog(config)
        if (!token) return Response.json({ error: 'Not connected' }, { status: 400 })

        const pixel = await graphGet<{ id?: string; name?: string }>(`/${body.pixelId}`, {
            fields: 'id,name',
            access_token: token,
        })
        if (!pixel.ok || !pixel.data?.id) {
            return Response.json({ error: pixel.error || 'That Pixel is not on this Facebook login.' }, { status: 404 })
        }

        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: body.configId,
            data: { pixelId: pixel.data.id, pixelEnabled: true },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })
        return Response.json({ ok: true, pixelId: pixel.data.id, name: pixel.data.name || pixel.data.id })
    },
}

// ── POST /meta-oauth/pixels { configId, name } ──────────────────────────────
export const metaOAuthCreatePixelEndpoint: Endpoint = {
    path: '/meta-oauth/pixels',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const body = (await req.json?.()) as { configId?: string; name?: string; businessId?: string } | undefined
        const configId = body?.configId
        const name = body?.name?.trim()
        if (!configId || !name) return Response.json({ error: 'Missing configId or name' }, { status: 400 })

        const config = await loadConfig(req.payload, configId)
        if (!callerOwnsConfigSite(req, config)) {
            return Response.json({ error: 'Forbidden' }, { status: 403 })
        }
        const token = tokenForCatalog(config)
        if (!token) return Response.json({ error: 'Not connected' }, { status: 400 })
        const businesses = await listBusinesses(token, body.businessId || config.businessManagerId)
        if (!businesses.ok) return Response.json({ error: businesses.error }, { status: 502 })
        const business = businesses.businesses.find((item) => item.id === body.businessId) || businesses.businesses[0]
        if (!business) return Response.json({ error: 'This Facebook login has no Business Manager to own a Pixel.' }, { status: 400 })

        const result = await graphPost<{ id?: string }>(`/${business.id}/adspixels`, {
            name,
            access_token: token,
        })
        if (!result.ok || !result.data?.id) {
            return Response.json({ error: result.error || 'Pixel creation failed' }, { status: 502 })
        }

        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: configId,
            data: { pixelId: result.data.id, pixelEnabled: true, businessManagerId: business.id },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        return Response.json({ ok: true, pixelId: result.data.id, businessId: business.id })
    },
}
