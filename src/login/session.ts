import { getFieldsToSign, jwtSign } from 'payload'
import { addSessionToUser, generatePayloadCookie } from 'payload/shared'
import type { PayloadRequest, SanitizedCollectionConfig } from 'payload'

import type { LoginSession } from '../types/login'

/**
 * Signs a person in to the platform: the same session a password login creates, so everything that follows a sign-in behaves the
 * same (the session list, the token and its expiry, the audit rows, a suspended account being refused, the platform's sign-in event).
 *
 * This mirrors what Payload's own login does after the password has been checked, using Payload's own exported pieces, because
 * Payload has no "log in without a password" call. Facebook has taken the place of the password check.
 */
export async function startPlatformSession(req: PayloadRequest, usersSlug: string, user: Record<string, unknown>, secure: boolean): Promise<LoginSession> {
    const { payload } = req
    const collection = payload.collections[usersSlug as keyof typeof payload.collections]
    if (!collection) throw new Error(`There is no "${usersSlug}" collection to sign in to.`)
    const config: SanitizedCollectionConfig = collection.config
    if (!config.auth) throw new Error(`"${usersSlug}" is not a collection people sign in to.`)
    const account = { ...user } as Record<string, unknown> & { id: string | number; email?: string }

    // The hooks Payload runs around a login (beforeLogin may refuse: a suspended account is turned away there).
    for (const hook of config.hooks?.beforeLogin ?? []) {
        await hook({ collection: config, context: req.context, req, user: account as never })
    }

    const { sid } = await addSessionToUser({ collectionConfig: config, payload, req, user: account as never })
    const fieldsToSign = getFieldsToSign({ collectionConfig: config, email: account.email as string, user: account as never, ...(sid ? { sid } : {}) })
    const { token } = await jwtSign({ fieldsToSign, secret: payload.secret, tokenExpiration: config.auth.tokenExpiration ?? 7200 })

    req.user = { ...account, collection: usersSlug } as never
    for (const hook of config.hooks?.afterLogin ?? []) {
        await hook({ collection: config, context: req.context, req, token, user: account as never })
    }

    const cookie = generatePayloadCookie({ collectionAuthConfig: config.auth, cookiePrefix: payload.config.cookiePrefix, token, returnCookieAsObject: false as const })
    return { token, cookie: secure && !/;\s*Secure/i.test(cookie) ? `${cookie}; Secure` : cookie }
}
