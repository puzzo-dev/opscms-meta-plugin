import { createHmac } from 'node:crypto'

import { graphGet } from '../utils/metaGraphClient'
import type { FacebookProfile, GraphProfileResult, GraphTokenResult } from '../types/login'

/** What the platform asks Facebook for when someone signs in: their name, id and email. No review is needed for these two. */
export const LOGIN_SCOPE = 'email,public_profile'

/** The code Facebook sent back, exchanged for an access token (a short one: it is used once, right now, and not kept). */
export async function exchangeLoginCode(code: string, app: { appId: string; appSecret: string }, redirectUri: string): Promise<GraphTokenResult> {
    const result = await graphGet<{ access_token?: string }>('/oauth/access_token', {
        client_id: app.appId,
        client_secret: app.appSecret,
        redirect_uri: redirectUri,
        code,
    })
    if (!result.ok || !result.data?.access_token) return { ok: false, error: result.error ?? 'Facebook did not accept the sign-in.' }
    return { ok: true, accessToken: result.data.access_token }
}

/**
 * Who the token belongs to. `appsecret_proof` shows Facebook the request comes from this app's server, so a leaked token alone
 * cannot be used to ask on our behalf.
 */
export async function fetchLoginProfile(accessToken: string, appSecret: string): Promise<GraphProfileResult> {
    const proof = createHmac('sha256', appSecret).update(accessToken).digest('hex')
    const result = await graphGet<{ id?: string; name?: string; email?: string }>('/me', {
        fields: 'id,name,email',
        access_token: accessToken,
        appsecret_proof: proof,
    })
    if (!result.ok || !result.data?.id) return { ok: false, error: result.error ?? 'Facebook did not say who this is.' }
    const profile: FacebookProfile = { id: String(result.data.id) }
    if (typeof result.data.name === 'string') profile.name = result.data.name
    if (typeof result.data.email === 'string' && result.data.email.trim()) profile.email = result.data.email.trim().toLowerCase()
    return { ok: true, profile }
}
