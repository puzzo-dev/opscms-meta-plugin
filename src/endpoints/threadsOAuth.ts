import type { Endpoint } from 'payload'
import { encryptCredential, signOAuthState, verifyOAuthState, getMetaAppCredentials } from '../utils/metaCrypto'
import { threadsGet, threadsPost } from '../utils/metaGraphClient'
import { callerOwnsConfigSite, getUserWithRole, asCollectionSlug } from '../types'

/**
 * Threads connect flow. Threads API is a genuinely separate product from the
 * main Facebook/Instagram Graph API — its own authorize host (threads.net,
 * not facebook.com), its own token host (graph.threads.net, not
 * graph.facebook.com), and its own token/profile shape — even though it's
 * configured as a product on the same Meta App (same App ID/Secret as the
 * Facebook/Instagram connection reuses).
 *
 * Same caveat as metaOAuth.ts: implemented per Meta's documented Threads API
 * contract, not live-tested against a real Threads App — verify with a
 * manual test connect before relying on this in production.
 */

const THREADS_SCOPES = 'threads_basic,threads_content_publish'

function isAdminOrAbove(req: { user?: unknown }): boolean {
    const role = getUserWithRole(req.user)?.role
    return role === 'super-admin' || role === 'admin' || role === 'editor'
}

function serverUrl(): string {
    return (process.env.PAYLOAD_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')
}

function callbackRedirectUri(): string {
    return `${serverUrl()}/api/threads-oauth/callback`
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

// ── GET /threads-oauth/start?configId=<id> ─────────────────────────────────
export const threadsOAuthStartEndpoint: Endpoint = {
    path: '/threads-oauth/start',
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
            return Response.json({ error: 'Meta App not configured on this deployment — enter its App ID and secret in Platform Settings (or set META_APP_ID and META_APP_SECRET).' }, { status: 400 })
        }

        const state = signOAuthState(configId)
        const params = new URLSearchParams({
            client_id: appCreds.appId,
            redirect_uri: callbackRedirectUri(),
            state,
            scope: THREADS_SCOPES,
            response_type: 'code',
        })

        return Response.redirect(`https://threads.net/oauth/authorize?${params}`, 302)
    },
}

// ── GET /threads-oauth/callback?code=&state= ────────────────────────────────
export const threadsOAuthCallbackEndpoint: Endpoint = {
    path: '/threads-oauth/callback',
    method: 'get',
    handler: async (req) => {
        const code = req.query?.code as string | undefined
        const state = req.query?.state as string | undefined
        const oauthError = req.query?.error_description as string | undefined

        const adminBase = `${serverUrl()}/admin/collections/meta-config`

        if (oauthError) {
            return Response.redirect(`${adminBase}?threads_oauth_error=${encodeURIComponent(oauthError)}`, 302)
        }
        if (!code || !state) {
            return Response.redirect(`${adminBase}?threads_oauth_error=${encodeURIComponent('Missing code or state')}`, 302)
        }

        const configId = verifyOAuthState(state)
        if (!configId) {
            return Response.redirect(`${adminBase}?threads_oauth_error=${encodeURIComponent('Invalid or expired connect request — try again')}`, 302)
        }

        try {
            await loadConfig(req.payload, configId)
        } catch {
            return Response.redirect(`${adminBase}?threads_oauth_error=${encodeURIComponent('Config not found')}`, 302)
        }

        const appCreds = getMetaAppCredentials()
        if (!appCreds) {
            return Response.redirect(`${adminBase}/${configId}?threads_oauth_error=${encodeURIComponent('Meta App not configured on this deployment — enter its App ID and secret in Platform Settings (or set META_APP_ID and META_APP_SECRET).')}`, 302)
        }

        // Step 1: code -> short-lived Threads user token
        const shortLived = await threadsPost<{ access_token?: string; user_id?: string }>('/oauth/access_token', {
            client_id: appCreds.appId,
            client_secret: appCreds.appSecret,
            grant_type: 'authorization_code',
            redirect_uri: callbackRedirectUri(),
            code,
        })
        if (!shortLived.ok || !shortLived.data?.access_token) {
            return Response.redirect(`${adminBase}/${configId}?threads_oauth_error=${encodeURIComponent(shortLived.error || 'Token exchange failed')}`, 302)
        }

        // Step 2: short-lived -> long-lived Threads token (~60 days)
        const longLived = await threadsGet<{ access_token?: string; expires_in?: number }>('/access_token', {
            grant_type: 'th_exchange_token',
            client_secret: appCreds.appSecret,
            access_token: shortLived.data.access_token,
        })
        const finalToken = longLived.ok && longLived.data?.access_token ? longLived.data.access_token : shortLived.data.access_token
        // No refresh_token grant on the Threads API either — same tracking
        // rationale as metaOAuth.ts's oauthExpiresAt.
        const threadsTokenExpiresAt = new Date(
            Date.now() + (longLived.ok ? (longLived.data?.expires_in ?? 60 * 24 * 60 * 60) : 60 * 24 * 60 * 60) * 1000,
        ).toISOString()

        // Step 3: fetch profile (id, username)
        const profile = await threadsGet<{ id?: string; username?: string }>('/v1.0/me', {
            fields: 'id,username',
            access_token: finalToken,
        })

        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: configId,
            data: {
                threadsEnabled: true,
                threadsAccessToken: encryptCredential(finalToken),
                threadsTokenExpiresAt,
                threadsUserId: profile.data?.id || null,
                threadsUsername: profile.data?.username || null,
            },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        return Response.redirect(`${adminBase}/${configId}?threads_oauth_success=1`, 302)
    },
}
