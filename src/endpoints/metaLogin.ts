import type { Endpoint, PayloadRequest } from 'payload'

import { exchangeLoginCode, fetchLoginProfile, LOGIN_SCOPE } from '../login/facebook'
import { resolveLoginUser } from '../login/resolveUser'
import { startPlatformSession } from '../login/session'
import { clearedStateCookie, newState, readCookie, STATE_COOKIE, stateCookie, statesMatch } from '../login/state'
import type { FacebookLoginFailure } from '../types/login'
import type { MetaHost } from '../types/host'
import { getMetaAppCredentials } from '../utils/metaCrypto'
import { GRAPH_API_VERSION } from '../utils/metaGraphClient'

/**
 * Sign in to the platform with Facebook (the platform's Meta app, the same one customers connect their business accounts through).
 *
 *  - GET  /api/meta-login/status    whether the button should be shown (Meta is set up on this server).
 *  - GET  /api/meta-login/start     sends the browser to Facebook.
 *  - GET  /api/meta-login/callback  Facebook sends the browser back here; the person is signed in or sent back to the login page.
 *  - POST /api/meta-login/unlink    a signed-in person disconnects their own Facebook account.
 *
 * An account is joined to a Facebook account when the emails are the same. Signing in never creates an account.
 */

const serverUrl = (): string => (process.env.PAYLOAD_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')
const isSecure = (): boolean => serverUrl().startsWith('https://')
const callbackUri = (): string => `${serverUrl()}/api/meta-login/callback`
const SIGN_IN_ATTEMPTS = { max: 30, windowMs: 15 * 60_000 }

/** Back to the login page with a fixed code (never text taken from the request), clearing the one-time cookie. */
function backToLogin(code: FacebookLoginFailure): Response {
    const headers = new Headers({ Location: `${serverUrl()}/admin/login?fb_error=${code}` })
    headers.append('Set-Cookie', clearedStateCookie(isSecure()))
    return new Response(null, { status: 302, headers })
}

export function createMetaLoginEndpoints(host?: MetaHost): Endpoint[] {
    const throttled = async (req: PayloadRequest): Promise<boolean> => {
        if (!host?.rateLimit) return false
        const verdict = await host.rateLimit.check(`meta-login:${host.rateLimit.clientIp(req)}`, SIGN_IN_ATTEMPTS.max, SIGN_IN_ATTEMPTS.windowMs)
        return !verdict.allowed
    }
    const usersSlug = (req: PayloadRequest): string => (req.payload.config.admin?.user as string | undefined) ?? 'users'

    const status: Endpoint = {
        path: '/meta-login/status',
        method: 'get',
        handler: async () => Response.json({ enabled: Boolean(getMetaAppCredentials()) }, { headers: { 'cache-control': 'no-store' } }),
    }

    const start: Endpoint = {
        path: '/meta-login/start',
        method: 'get',
        handler: async (req) => {
            const app = getMetaAppCredentials()
            if (!app) return backToLogin('not_configured')
            if (await throttled(req)) return new Response('Too many sign-in attempts. Try again in a few minutes.', { status: 429 })
            const state = newState()
            const params = new URLSearchParams({ client_id: app.appId, redirect_uri: callbackUri(), state, scope: LOGIN_SCOPE, response_type: 'code' })
            const headers = new Headers({ Location: `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?${params}` })
            headers.append('Set-Cookie', stateCookie(state, isSecure()))
            return new Response(null, { status: 302, headers })
        },
    }

    const callback: Endpoint = {
        path: '/meta-login/callback',
        method: 'get',
        handler: async (req) => {
            const app = getMetaAppCredentials()
            if (!app) return backToLogin('not_configured')
            if (await throttled(req)) return new Response('Too many sign-in attempts. Try again in a few minutes.', { status: 429 })

            if (req.query?.error) return backToLogin('denied')
            const code = typeof req.query?.code === 'string' ? req.query.code : undefined
            const state = typeof req.query?.state === 'string' ? req.query.state : undefined
            if (!code || !statesMatch(state, readCookie(req.headers.get('cookie'), STATE_COOKIE))) return backToLogin('state')

            const token = await exchangeLoginCode(code, app, callbackUri())
            if (!token.ok) {
                req.payload.logger.warn(`[meta-login] Facebook did not accept the sign-in: ${token.error}`)
                return backToLogin('failed')
            }
            const profile = await fetchLoginProfile(token.accessToken, app.appSecret)
            if (!profile.ok) {
                req.payload.logger.warn(`[meta-login] Could not read the Facebook profile: ${profile.error}`)
                return backToLogin('failed')
            }

            const slug = usersSlug(req)
            const resolution = await resolveLoginUser(req.payload, slug, profile.profile)
            if (!resolution.ok) return backToLogin(resolution.code)

            let session
            try {
                session = await startPlatformSession(req, slug, resolution.user, isSecure())
            } catch (error) {
                // A suspended account is refused by the platform's own sign-in hook, with its message.
                const status = (error as { status?: number }).status
                req.payload.logger.warn(`[meta-login] Sign-in refused: ${error instanceof Error ? error.message : String(error)}`)
                return backToLogin(status === 403 ? 'suspended' : 'failed')
            }
            if (resolution.linked) req.payload.logger.info(`[meta-login] Account ${String(resolution.user.id)} was joined to a Facebook account (same email).`)

            const headers = new Headers({ Location: `${serverUrl()}/admin` })
            headers.append('Set-Cookie', session.cookie)
            headers.append('Set-Cookie', clearedStateCookie(isSecure()))
            return new Response(null, { status: 302, headers })
        },
    }

    const unlink: Endpoint = {
        path: '/meta-login/unlink',
        method: 'post',
        handler: async (req) => {
            if (!req.user) return Response.json({ error: 'Sign in first.' }, { status: 401 })
            await req.payload.update({
                collection: usersSlug(req) as never,
                id: (req.user as { id: number | string }).id,
                data: { facebookId: null } as never,
                overrideAccess: true,
                context: { skipOwnership: true },
            })
            return Response.json({ unlinked: true })
        },
    }

    return [status, start, callback, unlink]
}
