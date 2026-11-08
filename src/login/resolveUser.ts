import type { CollectionSlug, Payload } from 'payload'

import type { FacebookProfile, LoginResolution } from '../types/login'

/**
 * Which platform account a Facebook sign-in belongs to. Every query here is a Payload Local API call (no SQL).
 *
 *  1. An account already linked to this Facebook id: that account. (Email is not looked at again: the link is the proof.)
 *  2. Otherwise an account whose email is the same as the Facebook email: the two are joined, and the link is kept, so later
 *     sign-ins go by id. If that account is already linked to a DIFFERENT Facebook account, it is refused rather than overwritten.
 *  3. Otherwise nothing: signing in never creates an account (accounts are made by invitation), and an account is never matched
 *     on a different email.
 *
 * Two kinds of account never sign in this way, whatever the link says: the platform owner (super-admin), who uses the ordinary
 * sign-in only, and any account that has two-factor sign-in switched on (Facebook cannot give a one-time code, so it would be a
 * way round the second factor). Both are checked before anything is linked.
 */
const refusal = (user: Record<string, unknown>): 'not_allowed' | 'two_factor' | null => {
    if (user.role === 'super-admin') return 'not_allowed'
    if (user.twoFactorEnabled === true) return 'two_factor'
    return null
}

export async function resolveLoginUser(payload: Payload, usersSlug: string, profile: FacebookProfile): Promise<LoginResolution> {
    const collection = usersSlug as CollectionSlug
    const find = async (where: Record<string, unknown>) =>
        (
            await payload.find({
                collection,
                where: where as never,
                limit: 1,
                depth: 0,
                overrideAccess: true,
                // The session list is hidden from ordinary reads; a sign-in needs it to add this one.
                showHiddenFields: true,
            })
        ).docs[0] as unknown as Record<string, unknown> | undefined

    try {
        const linked = await find({ facebookId: { equals: profile.id } })
        if (linked) {
            if (linked.suspended) return { ok: false, code: 'suspended' }
            const refused = refusal(linked)
            return refused ? { ok: false, code: refused } : { ok: true, user: linked, linked: false }
        }

        if (!profile.email) return { ok: false, code: 'no_email' }
        const byEmail = await find({ email: { equals: profile.email.toLowerCase() } })
        if (!byEmail) return { ok: false, code: 'no_account' }
        if (byEmail.suspended) return { ok: false, code: 'suspended' }
        const refused = refusal(byEmail)
        if (refused) return { ok: false, code: refused }
        if (typeof byEmail.facebookId === 'string' && byEmail.facebookId && byEmail.facebookId !== profile.id) return { ok: false, code: 'conflict' }

        await payload.update({
            collection,
            id: byEmail.id as number | string,
            data: { facebookId: profile.id } as never,
            overrideAccess: true,
            // Joining an account is not an ownership change.
            context: { skipOwnership: true },
        })
        return { ok: true, user: { ...byEmail, facebookId: profile.id }, linked: true }
    } catch (error) {
        payload.logger.error({ err: error }, '[meta-login] Could not look up the account')
        return { ok: false, code: 'failed' }
    }
}
